// Ordered before-submit checks (docs/plan/08, prototype E8). Each step
// returns at once on block. Plugin `onBeforeSubmit` never sees `newline`.

import type { Clock, Draft, HostState, SubmitDecision, SubmitTransaction } from '@murmo/api';
import type { HostCapabilities, SubmitOutcome } from '@murmo/api/adapter';
import { unsafeText } from '@murmo/text';
import type { PluginEntry } from '../hooks.ts';
import type { MenuSurface } from './menu.ts';
import { projectDraft } from './project.ts';
import type { SubmitAccess, SubmitDecisionCounts } from './types.ts';

export const REWRITE_DIAGNOSTIC = (id: string): string =>
  `Plugin ${id} proposed a submit rewrite; third-party transforms are forbidden`;

export interface PipelineHooks {
  readonly clock: Clock;
  readonly deadlineMs: number;
  readonly access: SubmitAccess;
  readonly menu: MenuSurface;
  readonly guardPolicy: 'managed' | 'final-boundary';
  readonly evidence: HostCapabilities['inputOriginEvidence'];
  /** Live draft version; compared to the snapshot after every plugin. */
  readonly version: () => number;
  readonly epoch: () => number;
  readonly state: () => HostState;
  readonly caps: HostCapabilities;
  readonly plugins: () => readonly PluginEntry[];
  readonly notice: (text: string) => void;
  readonly count: (pluginId: string, action: keyof SubmitDecisionCounts) => void;
  readonly fault: (plugin: PluginEntry, error: unknown) => void;
  /**
   * Run `onBeforeSubmit` with this attempt's remaining budget. The runner
   * may reject with a typed fault; a timeout is reported as `{ code: 'timeout' }`.
   */
  readonly run: (plugin: PluginEntry, tx: SubmitTransaction, remainingMs: number) => Promise<unknown>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function asDecision(value: unknown): SubmitDecision {
  if (!value || typeof value !== 'object') return { action: 'send' };
  const action = (value as { action?: unknown }).action;
  if (action === 'block' && typeof (value as { reason?: unknown }).reason === 'string') {
    return { action: 'block', reason: (value as { reason: string }).reason };
  }
  if (action === 'replace' && typeof (value as { text?: unknown }).text === 'string') {
    return { action: 'replace', text: (value as { text: string }).text };
  }
  return { action: 'send' };
}

const blocked = (reason: string): SubmitOutcome => ({ action: 'block', reason });

export interface PipelineOptions {
  /** `finalGuard`: skip transforms and edits; honor send/block only. */
  readonly guardsOnly?: boolean;
}

/**
 * Steps 1–10. `tx.position` is the adapter's claim; `coverage` on a send or
 * replace is that same position, never upgraded.
 */
export async function runPipeline(
  tx: SubmitTransaction,
  hooks: PipelineHooks,
  options: PipelineOptions = {},
): Promise<SubmitOutcome> {
  const caps = hooks.caps;
  const position = tx.position;
  const plugins = hooks.plugins();
  const guards = plugins.filter((p) => p.guard);
  const anyGuard = guards.length > 0;
  const guardsOnly = options.guardsOnly === true;

  const block = (reason: string): SubmitOutcome => {
    hooks.notice(reason);
    return blocked(reason);
  };

  // 1. Native popup or dialog (defensive; adapters should not get here).
  const state = hooks.state();
  if (state.popup !== null || state.dialog) return blocked('native UI owns submit gesture');

  // 2. Plugin menu at this version: dismiss, do not count as a submit attempt.
  if (hooks.menu.visibleAt(tx.draft.version)) {
    hooks.menu.dismiss();
    return blocked('plugin menu dismissed; submit again');
  }

  // 3. newline never runs guards (and should not reach this function).
  if ((tx.gesture as string) === 'newline') return { action: 'send', coverage: position };

  // 4. Unsafe text.
  if (unsafeText(tx.draft.text) !== null) return block('unsafe prompt text rejected');

  // 5. Gesture the host does not intercept.
  if (!caps.submit.gestures.includes(tx.gesture)) return block('submit gesture unsupported');

  // 6. A guard is configured but this host cannot block.
  if (anyGuard && !caps.submit.block) return block('guard block capability unavailable');

  // 7. Policy wants a final boundary this call is not.
  if (hooks.guardPolicy === 'final-boundary' && position !== 'final-boundary') {
    return block('final guard boundary unavailable');
  }

  // 8. Guards refuse an unknown draft: nothing about it is proven.
  if (anyGuard && tx.draft.certainty === 'unknown') return block('draft certainty unknown');

  const start = hooks.clock.now();
  const born = hooks.epoch();
  const snapshot = tx.draft.version;
  let text = tx.draft.text;

  const moved = (): boolean => hooks.epoch() !== born || hooks.version() !== snapshot;

  // 9. Plugins in user order.
  for (const plugin of plugins) {
    if (plugin.guard) {
      if (!plugin.activated) return block(`${plugin.name}: guard not activated`);
      if (plugin.disabled) return block(`${plugin.name}: guard disabled`);
      if (!hooks.access.maySubmit(plugin)) return block(`${plugin.name}: permission denied`);
    }
    if (plugin.disabled || !plugin.hooks.has('onBeforeSubmit')) continue;
    if (!hooks.access.maySubmit(plugin)) continue;

    const remaining = hooks.deadlineMs - (hooks.clock.now() - start);
    if (remaining <= 0) {
      if (plugin.guard) return block(`${plugin.name}: total deadline`);
      continue;
    }

    const body: Draft = {
      ...clone(tx.draft),
      text,
      cursor: Math.min(tx.draft.cursor, text.length),
      typedSpans: text === tx.draft.text ? tx.draft.typedSpans : [],
    };
    const projected = projectDraft(body, plugin, hooks.access, hooks.evidence);
    const callTx: SubmitTransaction = { draft: projected, gesture: tx.gesture, position };

    let raw: unknown;
    try {
      raw = await hooks.run(plugin, callTx, remaining);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      hooks.fault(plugin, error);
      if (plugin.guard) {
        const why = code === 'timeout' ? 'total deadline' : String((error as { message?: unknown })?.message ?? error);
        return block(`${plugin.name}: ${why}`);
      }
      continue;
    }
    if (moved()) return block('draft changed during submit');

    const decision = asDecision(raw);
    if (decision.action === 'block') {
      hooks.count(plugin.id, 'block');
      return block(decision.reason);
    }
    if (decision.action !== 'replace') {
      hooks.count(plugin.id, 'send');
      continue;
    }
    if (guardsOnly || decision.text === projected.text) {
      hooks.count(plugin.id, 'send');
      continue;
    }
    if (!plugin.builtin) {
      hooks.count(plugin.id, 'replace');
      return block(REWRITE_DIAGNOSTIC(plugin.id));
    }
    if (!caps.submit.transform) {
      if (plugin.guard) return block('guard transform capability unavailable');
      hooks.notice(`${plugin.name}: transform unsupported; skipped`);
      continue;
    }
    if (unsafeText(decision.text) !== null) return block('unsafe submit transform rejected');
    hooks.count(plugin.id, 'replace');
    text = decision.text;
  }

  // 10. Final version recheck.
  if (moved()) return block('draft changed during submit');
  return text === tx.draft.text
    ? { action: 'send', coverage: position }
    : { action: 'replace', text, coverage: position };
}

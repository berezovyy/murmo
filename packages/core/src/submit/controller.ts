// Session-facing submit controller: the before-submit pipeline, the
// gesture-to-commit window (edits denied with `submit-in-progress`),
// `finalGuard`, and committed delivery.

import type {
  Capabilities,
  Clock,
  Draft,
  HostName,
  InputOriginEvidence,
  PluginHook,
  SubmitGesture,
  SubmitTransaction,
} from '@murmo/api';
import type { HostCapabilities, HostSubmitAccepted, SubmitOutcome } from '@murmo/api/adapter';
import { splice } from '@murmo/provenance';
import type { CommitGate, CommitRequest } from '../edits.ts';
import { faultOf, type HookCall, type HookRunner, type PluginEntry } from '../hooks.ts';
import { issueTicket, type SessionView, type Ticket } from '../stale.ts';
import type { Counters } from '../stats.ts';
import { CommitDelivery, type CommitResolution } from './delivery.ts';
import type { MenuSurface } from './menu.ts';
import { runPipeline } from './pipeline.ts';
import {
  COMMIT_WINDOW_MS,
  declaredAccess,
  emptyDecisions,
  type SubmitAccess,
  type SubmitDecisionCounts,
  submitDeadlineMs,
} from './types.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const TIMEOUT = Object.assign(new Error('total deadline'), { code: 'timeout' as const });

export interface SubmitControllerDeps {
  readonly host: () => { name: HostName; version: string; caps: Capabilities };
  readonly adapterCaps: () => HostCapabilities;
  readonly view: SessionView;
  readonly runner: HookRunner;
  readonly clock: Clock;
  readonly plugins: () => readonly PluginEntry[];
  readonly counters: Counters;
  readonly notice: (text: string) => void;
  readonly menu: MenuSurface;
  readonly guardPolicy: 'managed' | 'final-boundary';
  readonly evidence: InputOriginEvidence;
  readonly access?: SubmitAccess;
  readonly deadlineMs: number;
  readonly commitWindowMs: number;
  readonly fault: (plugin: PluginEntry, hook: PluginHook, error: unknown) => void;
  readonly onLifecycleReset: () => void;
  readonly track: (work: Promise<unknown>) => Promise<void>;
  readonly seq: () => number;
  readonly setLatest: (pluginId: string, hook: PluginHook, seq: number) => void;
  readonly applyEffects: (plugin: PluginEntry, value: unknown, ticket: Ticket) => Promise<void>;
  /** The inline typo fix for the prompt's last word (Enter ends it like a space), or null. */
  readonly finishWord?: (draft: Draft) => { from: number; to: number; insert: string } | null;
}

export class SubmitController implements CommitGate {
  readonly name = 'submit-in-progress';
  readonly #deps: SubmitControllerDeps;
  readonly #access: SubmitAccess;
  readonly #delivery: CommitDelivery;
  readonly #decisions = new Map<string, SubmitDecisionCounts>();
  #inFlight = false;
  #overflow = 0;

  constructor(deps: SubmitControllerDeps) {
    this.#deps = deps;
    this.#access = deps.access ?? declaredAccess();
    this.#delivery = new CommitDelivery({
      clock: deps.clock,
      access: this.#access,
      evidence: deps.evidence,
      plugins: deps.plugins,
      commitWindowMs: deps.commitWindowMs,
      alive: () => deps.view.alive,
      schedule: (plugin, hook, input) => this.#deps.track(this.#durable(plugin, hook, input)),
      onResolved: (level) => this.#resolved(level),
      onOverflow: () => {
        this.#overflow++;
        deps.counters.observerOverflow++;
      },
    });
  }

  get inFlight(): boolean {
    return this.#inFlight;
  }

  get decisions(): ReadonlyMap<string, SubmitDecisionCounts> {
    return this.#decisions;
  }

  get observerOverflow(): number {
    return this.#overflow;
  }

  check(_request: CommitRequest): string | null {
    return this.#inFlight ? 'submit-in-progress' : null;
  }

  async beforeSubmit(tx: SubmitTransaction): Promise<SubmitOutcome> {
    const counters = this.#deps.counters;
    counters.submits++;
    this.#inFlight = true;
    const fixed = this.#finishWord(tx);
    const sent = fixed ?? tx;
    let outcome: SubmitOutcome;
    try {
      outcome = await runPipeline(sent, this.#hooks(), { guardsOnly: false });
    } catch (error) {
      this.#inFlight = false;
      throw error;
    }
    if (outcome.action === 'block') {
      counters.blocked++;
      counters.lastBlockReason = outcome.reason;
      this.#inFlight = false;
      return outcome;
    }
    if (fixed) {
      counters.inlineCorrections++;
      if (outcome.action === 'send')
        outcome = { action: 'replace', text: fixed.draft.text, coverage: outcome.coverage };
    }
    const text = outcome.action === 'replace' ? outcome.text : sent.draft.text;
    this.#delivery.arm({
      submissionId: this.#delivery.nextInferredId(),
      gesture: tx.gesture,
      text,
      position: tx.position,
      typedSpans: text === sent.draft.text ? sent.draft.typedSpans : [],
      forwardedAt: this.#deps.clock.now(),
    });
    return outcome;
  }

  /**
   * Enter ends the last word like a space, so its typo fix rides this submit
   * as a transform: the host puts it in the box (Pi, OpenCode, Codex) or the
   * sent text (Claude) before sending. A final-boundary call can only pass or
   * block, and a host without transforms sends the word as typed.
   */
  #finishWord(tx: SubmitTransaction): SubmitTransaction | null {
    if (tx.position !== 'managed' || !this.#deps.adapterCaps().submit.transform) return null;
    const fix = this.#deps.finishWord?.(tx.draft);
    if (!fix) return null;
    const { draft } = tx;
    const text = draft.text.slice(0, fix.from) + fix.insert + draft.text.slice(fix.to);
    const typedSpans = splice(draft.typedSpans, fix.from, fix.to, fix.insert.length, false);
    return { ...tx, draft: { ...draft, text, cursor: text.length, typedSpans } };
  }

  /** Guards-only pass at the host's final boundary; no transforms, no commit window. */
  async finalGuard(input: { text: string; gesture: SubmitGesture }): Promise<SubmitOutcome> {
    const view = this.#deps.view;
    const tx: SubmitTransaction = {
      draft: {
        ...clone(view.draft),
        text: input.text,
        cursor: Math.min(view.draft.cursor, input.text.length),
      },
      gesture: input.gesture,
      position: 'final-boundary',
    };
    return runPipeline(tx, this.#hooks(), { guardsOnly: true });
  }

  noteAccepted(event: HostSubmitAccepted): void {
    this.#delivery.noteAccepted(event);
  }

  noteChange(draft: Draft): void {
    this.#delivery.noteChange(draft, this.#deps.adapterCaps().submit.committed);
  }

  noteKey(): void {
    this.#delivery.noteKey();
  }

  dispose(): void {
    this.#delivery.dispose();
    this.#inFlight = false;
  }

  #resolved(level: CommitResolution): void {
    this.#inFlight = false;
    if (level === 'unknown') {
      this.#deps.counters.unresolved++;
      return;
    }
    this.#deps.counters.committed++;
    this.#deps.onLifecycleReset();
  }

  #hooks() {
    const deps = this.#deps;
    return {
      clock: deps.clock,
      deadlineMs: deps.deadlineMs,
      access: this.#access,
      menu: deps.menu,
      guardPolicy: deps.guardPolicy,
      evidence: deps.evidence,
      version: () => deps.view.draft.version,
      epoch: () => deps.view.epoch,
      state: () => deps.view.state(),
      caps: deps.adapterCaps(),
      plugins: deps.plugins,
      notice: deps.notice,
      count: (pluginId: string, action: keyof SubmitDecisionCounts) => {
        let row = this.#decisions.get(pluginId);
        if (!row) {
          row = emptyDecisions();
          this.#decisions.set(pluginId, row);
        }
        row[action]++;
      },
      fault: (plugin: PluginEntry, error: unknown) => deps.fault(plugin, 'onBeforeSubmit', error),
      run: (plugin: PluginEntry, tx: SubmitTransaction, remainingMs: number) =>
        this.#runSubmit(plugin, tx, remainingMs),
    };
  }

  async #runSubmit(plugin: PluginEntry, tx: SubmitTransaction, remainingMs: number): Promise<unknown> {
    const deps = this.#deps;
    const view = deps.view;
    const seq = deps.seq();
    deps.setLatest(plugin.id, 'onBeforeSubmit', seq);
    const ticket = issueTicket(plugin.id, 'onBeforeSubmit', seq, view);
    const call: HookCall = {
      pluginId: plugin.id,
      hook: 'onBeforeSubmit',
      input: clone(tx),
      ticket,
      signal: {
        get cancelled() {
          return !view.alive;
        },
      },
      snapshot: { host: deps.host(), draft: tx.draft, state: view.state() },
      timeoutMs: remainingMs,
    };
    const work = deps.runner.run(call);
    const raced = await Promise.race([
      work.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      deps.clock.sleep(Math.max(0, remainingMs)).then(() => ({ ok: false as const, error: TIMEOUT })),
    ]);
    if (!raced.ok) {
      void work.then(
        () => {},
        () => {},
      );
      throw raced.error;
    }
    return raced.value;
  }

  async #durable(plugin: PluginEntry, hook: PluginHook, input: unknown): Promise<void> {
    const deps = this.#deps;
    const view = deps.view;
    if (!view.alive || plugin.disabled || !plugin.hooks.has(hook)) return;
    const seq = deps.seq();
    deps.setLatest(plugin.id, hook, seq);
    const ticket = issueTicket(plugin.id, hook, seq, view);
    const call: HookCall = {
      pluginId: plugin.id,
      hook,
      input: clone(input),
      ticket,
      signal: {
        get cancelled() {
          return !view.alive;
        },
      },
      snapshot: { host: deps.host(), draft: view.draft, state: view.state() },
    };
    try {
      const value = await deps.runner.run(call);
      await deps.applyEffects(plugin, value, ticket);
    } catch (error) {
      if (faultOf(error, plugin.id, hook).code === 'cancelled') return;
      deps.fault(plugin, hook, error);
    }
  }
}

export function submitOptions(options: {
  clock?: Clock;
  guardPolicy?: 'managed' | 'final-boundary';
  scaleSubmitDeadline?: boolean;
  pressure?: number;
  commitWindowMs?: number;
}): { clock: Clock; guardPolicy: 'managed' | 'final-boundary'; deadlineMs: number; commitWindowMs: number } {
  return {
    clock: options.clock ?? frozenClock,
    guardPolicy: options.guardPolicy ?? 'managed',
    deadlineMs: submitDeadlineMs({
      scaleByPressure: options.scaleSubmitDeadline === true,
      ...(options.pressure === undefined ? {} : { pressure: options.pressure }),
    }),
    commitWindowMs: options.commitWindowMs ?? COMMIT_WINDOW_MS,
  };
}

/** No timeouts, no window: production sessions pass the executor clock. */
const frozenClock: Clock = {
  now: () => 0,
  wallTimeMs: () => 0,
  setTimer: () => () => {},
  sleep: () => new Promise<void>(() => {}),
};

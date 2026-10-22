// Synchronous key router: native UI, owned undo, merged menu, then claims.
// No plugin code, no await (lesson 46). Decision is data against cached state.

import type { Draft, HostState, KeyCondition, KeyId, MenuItem } from '@murmo/api';
import type { HostCapabilities } from '@murmo/api/adapter';
import { claimWrites, type ValidatedClaim } from './claims.ts';
import { atCodeLikeWord } from './code-like.ts';
import type { PluginEntry } from './hooks.ts';
import type { Menu } from './menu.ts';
import type { VisibleGhost } from './present.ts';
import type { Counters, DecisionBy } from './stats.ts';
import type { UndoGesture, UndoLog, UndoRecord } from './undo.ts';

export interface Decision {
  readonly result: 'consume' | 'pass';
  readonly by: DecisionBy;
  readonly pluginId?: string;
}

export interface KeyRouterDeps {
  readonly live: () => boolean;
  readonly caps: () => HostCapabilities;
  readonly draft: () => Draft;
  readonly state: () => HostState;
  readonly plugins: () => readonly PluginEntry[];
  readonly undo: UndoLog;
  readonly menu: Menu;
  readonly ghost: () => VisibleGhost | null;
  readonly editable: () => boolean;
  readonly counters: Counters;
  readonly bumpEpoch: () => void;
  readonly restore: (record: UndoRecord, gesture: UndoGesture) => void;
  readonly acceptGhost: (plugin: PluginEntry, text: string) => void;
  readonly dispatch: (plugin: PluginEntry, key: KeyId) => void;
  readonly menuSelect: (plugin: PluginEntry, item: MenuItem) => void;
  readonly render: () => void;
}

interface ConditionCtx {
  readonly pluginId: string;
  readonly editable: boolean;
  readonly ghostOwner: string | null;
  readonly menuOpen: boolean;
  readonly text: string;
  readonly cursor: number;
  readonly afterMyEdit: string | undefined;
}

/**
 * Conditions are a data table (lesson 46). `at-code-like-word` is the same
 * `codeLike` rule the names plugin uses (docs/plan/36).
 */
export const CONDITIONS: { readonly [K in KeyCondition]: (ctx: ConditionCtx) => boolean } = {
  always: () => true,
  editable: (ctx) => ctx.editable,
  'ghost-visible-by-me': (ctx) => ctx.ghostOwner === ctx.pluginId,
  'menu-open': (ctx) => ctx.menuOpen,
  'at-word-start': (ctx) => ctx.cursor === 0 || /\s/.test(ctx.text[ctx.cursor - 1] ?? ''),
  'after-my-edit': (ctx) => ctx.afterMyEdit === ctx.pluginId,
  'at-code-like-word': (ctx) => atCodeLikeWord(ctx.text, ctx.cursor),
};

function matches(claim: ValidatedClaim, ctx: ConditionCtx, interceptable: boolean): boolean {
  if (!claim.when.every((condition) => CONDITIONS[condition](ctx))) return false;
  if (claimWrites(claim) && (!ctx.editable || !interceptable)) return false;
  return true;
}

export class KeyRouter {
  readonly #deps: KeyRouterDeps;

  constructor(deps: KeyRouterDeps) {
    this.#deps = deps;
  }

  /**
   * One key. Order: not ready → native popup/dialog → owned undo → merged
   * menu → the first matching consuming claim. Never awaits.
   */
  route(key: KeyId): Decision {
    const d = this.#deps;
    if (!d.live()) return { result: 'pass', by: 'none' };
    d.counters.keys++;
    d.bumpEpoch();
    const state = d.state();
    // Native UI owns Tab/Enter/Esc/arrows; the undo window closes (the
    // prototype returned before clearing it).
    if (state.popup !== null || state.dialog) {
      d.undo.clear();
      return this.#count({ result: 'pass', by: 'native' });
    }
    const caps = d.caps();
    const draft = d.draft();
    const canEdit = d.editable();
    const interceptable = caps.keys.includes(key);
    if (canEdit && interceptable) {
      const record = d.undo.armed(draft);
      if (record && caps.edit.exactRestore && (key === 'Backspace' || caps.undoKeys.includes(key))) {
        d.undo.pop();
        d.restore(record, key === 'Backspace' ? 'backspace' : 'undo-key');
        return this.#count({ result: 'consume', by: 'undo' });
      }
    }
    const afterMyEdit = d.undo.top()?.owner;
    d.undo.clear();
    if (!canEdit) d.render();

    if (interceptable && d.menu.open) {
      const handled = d.menu.handleKey(key);
      if (handled === 'navigate' || handled === 'close') return this.#count({ result: 'consume', by: 'menu' });
      if (handled === 'native-completion') return this.#count({ result: 'pass', by: 'menu' });
      if (handled === 'select') {
        const chosen = d.menu.takeSelection();
        if (chosen) d.menuSelect(chosen.plugin, chosen.item);
        return this.#count(
          chosen ? { result: 'consume', by: 'menu', pluginId: chosen.plugin.id } : { result: 'consume', by: 'menu' },
        );
      }
    }

    if (!canEdit || !interceptable) return this.#count({ result: 'pass', by: 'none' });

    const ghost = d.ghost();
    const ctxBase = {
      editable: canEdit,
      ghostOwner: ghost?.owner ?? null,
      menuOpen: d.menu.open,
      text: draft.text,
      cursor: draft.cursor,
      afterMyEdit,
    };
    for (const plugin of d.plugins()) {
      if (plugin.disabled) continue;
      const ctx: ConditionCtx = { ...ctxBase, pluginId: plugin.id };
      for (const claim of plugin.claims) {
        if (claim.key !== key) continue;
        if (!matches(claim, ctx, interceptable)) continue;
        if (claim.action === 'dispatch') {
          d.dispatch(plugin, key);
          if (claim.consume) return this.#count({ result: 'consume', by: 'claim', pluginId: plugin.id });
          continue;
        }
        if (claim.action === 'accept-ghost') {
          if (!ghost || ghost.owner !== plugin.id) continue;
          d.acceptGhost(plugin, ghost.text);
        }
        return this.#count({ result: 'consume', by: 'claim', pluginId: plugin.id });
      }
    }
    return this.#count({ result: 'pass', by: 'none' });
  }

  #count(decision: Decision): Decision {
    this.#deps.counters.keyBy[decision.by]++;
    return decision;
  }
}

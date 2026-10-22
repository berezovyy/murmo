// Built-in names plugin: on-request menu of real project names. Never edits
// without an explicit accept (lesson 29). Native popups still win.

import type { Capabilities, Draft, Effect, HostState, KeyClaim, MenuItem, Plugin, PluginFactory } from '@murmo/api';
import { atCodeLikeWord, wordAtCursor } from '@murmo/core';
import {
  candidatesFrom,
  formatNameRow,
  loadPacked,
  MENU_ROWS,
  type NameCandidate,
  type PackedIndex,
  type RankedName,
  rankNames,
  wordKey,
} from '@murmo/vocab';
import { resolveNamesSettings } from './settings.ts';

export const NAMES_ID = 'names';
export const NAMES_VERSION = '1.0.0';
export const STALE_MS = 10 * 60 * 1000;

export interface NamesMetrics {
  accepted: number;
  reverted: number;
}

export interface NamesBackend {
  retrieve(key: string, raw: string): readonly NameCandidate[];
  exactName?(name: string): boolean;
  isEnglish?(word: string): boolean;
  /** Age of the last successful index pass, milliseconds. */
  indexAgeMs?: number;
}

export interface NamesState {
  backend: NamesBackend;
  metrics: NamesMetrics;
  enabled: boolean;
  key: string;
}

function claimsFor(key: string): readonly KeyClaim[] {
  return [{ key, when: ['editable', 'at-code-like-word'], action: 'dispatch', consume: true }];
}

function blocked(state: HostState): boolean {
  return state.popup !== null || state.dialog === true;
}

function lookup(token: string, backend: NamesBackend): RankedName[] {
  const k = wordKey(token);
  const candidates = backend.retrieve(k, token);
  return rankNames(token, candidates, {
    ...(backend.exactName ? { exactName: backend.exactName } : {}),
    ...(backend.isEnglish ? { isEnglish: backend.isEnglish } : {}),
  });
}

function itemsOf(ranked: readonly RankedName[], draft: Draft, start: number, caps: Capabilities): MenuItem[] {
  const native = caps.inline.nativeCompletion;
  const items: MenuItem[] = [];
  for (const row of ranked.slice(0, MENU_ROWS)) {
    const item: MenuItem = { id: row.name, label: formatNameRow(row), detail: row.location.kind };
    if (native) {
      items.push({
        ...item,
        inlineEdit: {
          baseVersion: draft.version,
          from: start,
          to: draft.cursor,
          insert: row.name,
          undoable: true,
        },
      });
    } else items.push(item);
  }
  return items;
}

function createPlugin(state: NamesState): Plugin {
  let start = -1;
  let shownVersion = -1;
  let typed = '';
  let pendingRevert: { typed: string } | null = null;

  const close = (version: number): Effect[] => {
    start = -1;
    shownVersion = -1;
    typed = '';
    return [{ type: 'menu', items: null, baseVersion: version }];
  };

  const open = (draft: Draft, hostState: HostState, caps: Capabilities, force: boolean): Effect[] => {
    if (!state.enabled || blocked(hostState)) return close(draft.version);
    if (!force && !caps.inline.nativeCompletion) return close(draft.version);
    if (!atCodeLikeWord(draft.text, draft.cursor)) return close(draft.version);
    const { start: from, word } = wordAtCursor(draft.text, draft.cursor);
    const ranked = lookup(word, state.backend);
    if (!ranked.length) {
      const status: Effect[] = caps.status
        ? [{ type: 'status', text: 'no project name matches', baseVersion: draft.version }]
        : [];
      return [...close(draft.version), ...status];
    }
    start = from;
    shownVersion = draft.version;
    typed = word;
    const items = itemsOf(ranked, draft, from, caps);
    const effects: Effect[] = [{ type: 'menu', items, baseVersion: draft.version }];
    const age = state.backend.indexAgeMs;
    if (caps.status && age !== undefined && age > STALE_MS) {
      const minutes = Math.floor(age / 60000);
      effects.push({
        type: 'status',
        text: `name index is ${minutes} minute${minutes === 1 ? '' : 's'} old`,
        baseVersion: draft.version,
      });
    }
    return effects;
  };

  return {
    name: NAMES_ID,
    version: NAMES_VERSION,
    permissions: ['draft:read', 'draft:write'],
    keys: claimsFor(state.key),
    actions: ['murmo.menu'],
    onChange(change, ctx) {
      if (pendingRevert && change.draft.text.includes(pendingRevert.typed)) {
        state.metrics.reverted++;
        pendingRevert = null;
      } else if (pendingRevert && change.origin !== 'plugin') {
        pendingRevert = null;
      }
      return open(change.draft, ctx.state, ctx.host.caps, false);
    },
    onKey(_key, ctx) {
      return open(ctx.draft, ctx.state, ctx.host.caps, true);
    },
    onAction(action, ctx) {
      if (action !== 'murmo.menu') return [];
      return open(ctx.draft, ctx.state, ctx.host.caps, true);
    },
    onMenuSelect(item, ctx) {
      if (ctx.host.caps.inline.nativeCompletion) return [];
      if (start < 0 || ctx.draft.version !== shownVersion) return [];
      const insert = item.id;
      pendingRevert = { typed };
      return [
        {
          type: 'edit',
          edit: {
            from: start,
            to: ctx.draft.cursor,
            insert,
            baseVersion: ctx.draft.version,
            undoable: true,
            label: 'name',
          },
        },
      ];
    },
  };
}

export function packedBackend(index: PackedIndex, english?: (w: string) => boolean): NamesBackend {
  return {
    retrieve(key, _raw) {
      return candidatesFrom(index, index.retrieve(key, 96));
    },
    exactName: (name) => index.findName(name),
    ...(english ? { isEnglish: english } : {}),
  };
}

export function memoryBackend(
  entries: readonly NameCandidate[],
  options: { english?: readonly string[] } = {},
): NamesBackend {
  const exact = new Set(entries.map((e) => e.name));
  const english = new Set((options.english ?? []).map((s) => s.toLowerCase()));
  return {
    retrieve() {
      return entries;
    },
    exactName: (name) => exact.has(name),
    isEnglish: (w) => english.has(w),
  };
}

export function createNamesState(
  backend: NamesBackend,
  settings: Readonly<Record<string, unknown>> = {},
  host = '',
): NamesState {
  const resolved = resolveNamesSettings(settings, host);
  return {
    backend,
    metrics: { accepted: 0, reverted: 0 },
    enabled: resolved.enabled,
    key: resolved.key,
  };
}

export function namesPlugin(
  backend: NamesBackend,
  settings: Readonly<Record<string, unknown>> = {},
  host = '',
): {
  readonly id: string;
  readonly builtin: true;
  readonly factory: PluginFactory;
  readonly state: NamesState;
} {
  const state = createNamesState(backend, settings, host);
  return {
    id: NAMES_ID,
    builtin: true,
    factory: () => createPlugin(state),
    state,
  };
}

export const namesFactory: PluginFactory = (settings) => {
  const empty: NamesBackend = { retrieve: () => [] };
  return createPlugin(createNamesState(empty, settings));
};

export function namesFromPacked(
  bytes: Uint8Array,
  settings: Readonly<Record<string, unknown>> = {},
  english?: (w: string) => boolean,
): ReturnType<typeof namesPlugin> {
  return namesPlugin(packedBackend(loadPacked(bytes), english), settings);
}

// Built-in names plugin: on-request menu of real project names. Never edits
// without an explicit accept (lesson 29). Native popups still win. Prose
// aliases (`outbox worker` → OutboxWorker) are on request only.

import type { Capabilities, Draft, Effect, HostState, KeyClaim, MenuItem, Plugin, PluginFactory } from '@murmo/api';
import { atCodeLikeWord, wordAtCursor } from '@murmo/core';
import {
  candidatesFrom,
  editDistance,
  formatNameRow,
  formatPathInsert,
  loadPacked,
  MENU_ROWS,
  type NameCandidate,
  type PackedIndex,
  type ProseSpan,
  proseSpan,
  type RankedName,
  rankAliases,
  rankNames,
  wordKey,
} from '@murmo/vocab';
import { resolveNamesSettings } from './settings.ts';

function edit1(a: string, b: string): boolean {
  return editDistance(a, b, 1) <= 1;
}

export const NAMES_ID = 'names';
export const NAMES_VERSION = '1.1.0';
export const STALE_MS = 10 * 60 * 1000;
export const PROJECT_REF_ID = 'insert-project-ref';

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
  if (key === 'Tab') {
    return [{ key, when: ['editable', 'at-code-like-word'], action: 'dispatch', consume: true }];
  }
  return [{ key, when: ['editable'], action: 'dispatch', consume: true }];
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

function lookupProse(span: ProseSpan, backend: NamesBackend, singleWord: boolean): RankedName[] {
  const words = singleWord ? span.words.slice(-1) : span.words;
  if (!words.length) return [];
  const seen = new Map<string, RankedName>();
  for (let n = words.length; n >= 1; n--) {
    const slice = words.slice(-n);
    const key = slice.join(' ');
    const ranked = rankAliases(slice, backend.retrieve(key, key));
    for (const row of ranked) {
      const prev = seen.get(row.name);
      if (!prev || row.score < prev.score) seen.set(row.name, row);
    }
  }
  return [...seen.values()]
    .sort((a, b) => a.score - b.score || b.refs - a.refs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MENU_ROWS);
}

function nameItems(ranked: readonly RankedName[], draft: Draft, start: number, caps: Capabilities): MenuItem[] {
  const native = caps.inline.nativeCompletion;
  const items: MenuItem[] = [];
  for (const row of ranked.slice(0, MENU_ROWS)) {
    const item: MenuItem = { id: `n:${row.name}`, label: formatNameRow(row), detail: row.location.kind };
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

function aliasItems(
  ranked: readonly RankedName[],
  draft: Draft,
  start: number,
  caps: Capabilities,
  twoActions: boolean,
): MenuItem[] {
  const native = caps.inline.nativeCompletion;
  const items: MenuItem[] = [];
  const room = MENU_ROWS;
  const pairs = twoActions ? Math.min(ranked.length, Math.floor(room / 2)) : Math.min(ranked.length, room);
  const take = twoActions ? ranked.slice(0, pairs) : ranked.slice(0, room);
  for (const row of take) {
    const nameItem: MenuItem = { id: `n:${row.name}`, label: formatNameRow(row), detail: row.location.kind };
    if (native) {
      items.push({
        ...nameItem,
        inlineEdit: {
          baseVersion: draft.version,
          from: start,
          to: draft.cursor,
          insert: row.name,
          undoable: true,
        },
      });
    } else items.push(nameItem);
    if (twoActions) {
      const insert = formatPathInsert(row.name, row.location.file);
      const pathItem: MenuItem = {
        id: `p:${row.name}`,
        label: insert,
        detail: 'with path',
      };
      if (native) {
        items.push({
          ...pathItem,
          inlineEdit: {
            baseVersion: draft.version,
            from: start,
            to: draft.cursor,
            insert,
            undoable: true,
          },
        });
      } else items.push(pathItem);
    }
  }
  return items.slice(0, MENU_ROWS);
}

function semicolonTrigger(text: string, cursor: number): { start: number; query: string } | null {
  const { start, word } = wordAtCursor(text, cursor);
  if (!word.startsWith(';')) return null;
  if (start > 0 && !/\s/.test(text[start - 1] ?? '')) return null;
  return { start, query: word.slice(1) };
}

function createPlugin(state: NamesState): Plugin {
  let start = -1;
  let shownVersion = -1;
  let typed = '';
  let pendingRevert: { typed: string } | null = null;
  let awaitingAliases = false;

  const close = (version: number): Effect[] => {
    start = -1;
    shownVersion = -1;
    typed = '';
    awaitingAliases = false;
    return [{ type: 'menu', items: null, baseVersion: version }];
  };

  const openNames = (draft: Draft, caps: Capabilities, from: number, word: string): Effect[] => {
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
    const items = nameItems(ranked, draft, from, caps);
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

  const openAliases = (
    draft: Draft,
    caps: Capabilities,
    span: ProseSpan,
    singleWord: boolean,
    twoActions: boolean,
  ): Effect[] => {
    const ranked = lookupProse(span, state.backend, singleWord);
    if (!ranked.length) {
      const status: Effect[] = caps.status
        ? [{ type: 'status', text: 'no project name matches', baseVersion: draft.version }]
        : [];
      return [...close(draft.version), ...status];
    }
    const from = singleWord ? wordAtCursor(draft.text, draft.cursor).start : span.start;
    start = from;
    shownVersion = draft.version;
    typed = draft.text.slice(from, draft.cursor);
    awaitingAliases = false;
    return [{ type: 'menu', items: aliasItems(ranked, draft, from, caps, twoActions), baseVersion: draft.version }];
  };

  const open = (draft: Draft, hostState: HostState, caps: Capabilities, force: boolean): Effect[] => {
    if (!state.enabled || blocked(hostState)) return close(draft.version);
    const semi = semicolonTrigger(draft.text, draft.cursor);
    if (semi) {
      start = semi.start;
      shownVersion = draft.version;
      typed = draft.text.slice(semi.start, draft.cursor);
      const before = proseSpan(draft.text.slice(0, semi.start).replace(/\s+$/, ''), semi.start);
      if (awaitingAliases && before) {
        return openAliases(draft, caps, { ...before, end: draft.cursor }, caps.inline.nativeCompletion, true);
      }
      // The row lists names for the prose before `;`; with none to insert (no
      // prose, an empty index) it would be a dead row, so it stays hidden.
      if (!before || lookupProse(before, state.backend, false).length === 0) return close(draft.version);
      const row: MenuItem = { id: PROJECT_REF_ID, label: 'Insert project reference', detail: 'project name' };
      return [{ type: 'menu', items: [row], baseVersion: draft.version }];
    }
    if (!force && !caps.inline.nativeCompletion) return close(draft.version);
    if (atCodeLikeWord(draft.text, draft.cursor)) {
      const { start: from, word } = wordAtCursor(draft.text, draft.cursor);
      return openNames(draft, caps, from, word);
    }
    if (force) {
      const span = proseSpan(draft.text, draft.cursor);
      if (!span) return close(draft.version);
      return openAliases(draft, caps, span, caps.inline.nativeCompletion, !caps.inline.nativeCompletion);
    }
    return close(draft.version);
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
      if (item.id === PROJECT_REF_ID) {
        awaitingAliases = true;
        const semi = semicolonTrigger(ctx.draft.text, ctx.draft.cursor);
        const before = proseSpan(
          ctx.draft.text.slice(0, semi?.start ?? ctx.draft.cursor).replace(/\s+$/, ''),
          semi?.start ?? ctx.draft.cursor,
        );
        if (!before) return close(ctx.draft.version);
        return openAliases(
          ctx.draft,
          ctx.host.caps,
          { ...before, end: ctx.draft.cursor },
          ctx.host.caps.inline.nativeCompletion,
          true,
        );
      }
      if (ctx.host.caps.inline.nativeCompletion) return [];
      if (start < 0 || ctx.draft.version !== shownVersion) return [];
      const insert = item.id.startsWith('p:') ? item.label : item.id.startsWith('n:') ? item.id.slice(2) : item.id;
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
    retrieve(key) {
      if (!key) return entries;
      const q = key.split(' ').filter(Boolean);
      if (!q.length) return entries;
      const hits = entries.filter((e) => {
        const words = e.key.split(' ').filter(Boolean);
        return q.some((w) => words.some((c) => c === w || c.startsWith(w) || w.startsWith(c) || edit1(w, c)));
      });
      return hits.length ? hits : entries;
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

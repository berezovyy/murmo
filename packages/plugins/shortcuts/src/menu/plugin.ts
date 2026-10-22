// Built-in `;` menu. Opening and filtering are `onChange` effects on the
// public menu API; Tab/Enter/Esc/arrows stay with the merged menu (phase 06).
// Native-completion hosts (Claude) get the expansion on the row; no imperative
// edit runs there (lesson 47).

import type { Capabilities, Draft, Effect, HostState, KeyClaim, MenuItem, Plugin, PluginFactory } from '@murmo/api';
import { type CompiledShortcuts, compileShortcuts } from '../compile.ts';
import { SAMPLE_SHORTCUTS } from './catalog.ts';
import { displayName, filterNames, MENU_ROWS, type NameTable, packNames, type RankedRow } from './pack.ts';
import { defaultCellMeasure, formatRow } from './rows.ts';
import { findTrigger, hostBlocksMenu, type Trigger } from './trigger.ts';

export const MENU_ID = 'menu';
export const MENU_VERSION = '1.0.0';
export const HISTORY_ID = '?';

export interface MenuOptions {
  /** Terminal width in cells; rows never exceed this (lesson 3). */
  readonly width?: number;
  /** Reserved `;?` history row for phase 35; hidden unless true. */
  readonly history?: boolean;
  /** Names a project entry overrode; shown with a `project` tag. */
  readonly overrides?: readonly string[];
}

export interface MenuState {
  table: NameTable;
  options: MenuOptions;
  swap(compiled: CompiledShortcuts, options?: MenuOptions): void;
}

const KEYS: readonly KeyClaim[] = [{ key: ';', when: ['editable', 'at-word-start'], action: 'dispatch' }];

function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = Object.create(null);
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text === 'string') out[key] = text;
  }
  return out;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : [];
}

function compiledFrom(settings: Readonly<Record<string, unknown>>): CompiledShortcuts {
  const entries = stringRecord(settings.replacements) ?? SAMPLE_SHORTCUTS;
  const sources = stringRecord(settings.sources);
  return compileShortcuts({
    replacements: Object.entries(entries).map(([shortcut, text]) => ({
      shortcut,
      text,
      origin: sources?.[shortcut] === 'project' ? 'project' : 'user',
    })),
    overrides: stringList(settings.overrides),
  });
}

function optionsFrom(settings: Readonly<Record<string, unknown>>, fallback: MenuOptions = {}): MenuOptions {
  const width =
    typeof settings.width === 'number' && Number.isInteger(settings.width) ? settings.width : fallback.width;
  return {
    ...(width !== undefined ? { width } : {}),
    ...(settings.history === true || fallback.history ? { history: true } : {}),
    overrides: stringList(settings.overrides).length ? stringList(settings.overrides) : (fallback.overrides ?? []),
  };
}

function usable(caps: Capabilities): boolean {
  return caps.menu && (caps.edit.atomic || caps.inline.nativeCompletion);
}

function historyQuery(query: string): boolean {
  return query === '' || HISTORY_ID.startsWith(query);
}

function buildItems(
  ranked: readonly RankedRow[],
  draft: Draft,
  trigger: Trigger,
  caps: Capabilities,
  table: NameTable,
  options: MenuOptions,
): MenuItem[] {
  const width = options.width ?? 87;
  // `;?…` is history search; this plugin yields so history owns the rows.
  if (options.history === true && trigger.query.startsWith(HISTORY_ID)) return [];
  const history = options.history === true && historyQuery(trigger.query);
  const room = history ? MENU_ROWS - 1 : MENU_ROWS;
  const native = caps.inline.nativeCompletion;
  const items: MenuItem[] = [];
  for (const { entry } of ranked.slice(0, room)) {
    const insert = table.expansions[entry.name];
    const item: MenuItem = {
      id: entry.name,
      label: native ? displayName(entry.name) : formatRow(entry, width, defaultCellMeasure),
      ...(entry.firstLine ? { detail: entry.firstLine } : {}),
    };
    if (native && insert !== undefined) {
      items.push({
        ...item,
        inlineEdit: {
          baseVersion: draft.version,
          from: trigger.start,
          to: draft.cursor,
          insert,
          undoable: true,
        },
      });
    } else items.push(item);
  }
  if (history) {
    const row: MenuItem = { id: HISTORY_ID, label: ';?', detail: 'Search prompt history' };
    if (native) {
      items.push({
        ...row,
        inlineEdit: {
          baseVersion: draft.version,
          from: draft.cursor,
          to: draft.cursor,
          insert: '?',
          undoable: true,
        },
      });
    } else items.push(row);
  }
  return items;
}

function createPlugin(state: MenuState): Plugin {
  let start = -1;
  let shownVersion = -1;

  const close = (version: number): Effect[] => {
    start = -1;
    shownVersion = -1;
    return [{ type: 'menu', items: null, baseVersion: version }];
  };

  const open = (draft: Draft, hostState: HostState, caps: Capabilities): Effect[] => {
    if (hostBlocksMenu(hostState) || !usable(caps)) return close(draft.version);
    const trigger = findTrigger(draft);
    if (!trigger) return close(draft.version);
    const ranked = filterNames(state.table, trigger.query);
    const items = buildItems(ranked, draft, trigger, caps, state.table, state.options);
    if (items.length === 0) return close(draft.version);
    start = trigger.start;
    shownVersion = draft.version;
    return [{ type: 'menu', items, baseVersion: draft.version }];
  };

  return {
    name: MENU_ID,
    version: MENU_VERSION,
    permissions: ['draft:read', 'draft:write'],
    keys: KEYS,
    actions: ['murmo.menu'],
    onChange(change, ctx) {
      return open(change.draft, ctx.state, ctx.host.caps);
    },
    onAction(action, ctx) {
      if (action !== 'murmo.menu') return [];
      return open(ctx.draft, ctx.state, ctx.host.caps);
    },
    onMenuSelect(item, ctx) {
      // Claude commits the row's `inlineEdit`; an imperative edit cannot (lesson 47).
      if (ctx.host.caps.inline.nativeCompletion) return [];
      if (item.id === HISTORY_ID) {
        return [
          {
            type: 'edit',
            edit: {
              from: ctx.draft.cursor,
              to: ctx.draft.cursor,
              insert: '?',
              baseVersion: ctx.draft.version,
              undoable: true,
              label: 'history',
            },
          },
        ];
      }
      if (start < 0 || ctx.draft.version !== shownVersion) return [];
      const insert = state.table.expansions[item.id];
      if (insert === undefined) return [];
      return [
        {
          type: 'edit',
          edit: {
            from: start,
            to: ctx.draft.cursor,
            insert,
            baseVersion: ctx.draft.version,
            undoable: true,
            label: 'shortcut',
          },
        },
      ];
    },
  };
}

export function createMenuState(compiled: CompiledShortcuts, options: MenuOptions = {}): MenuState {
  const box: MenuState = {
    table: packNames(compiled, options.overrides ?? []),
    options,
    swap(next, nextOptions) {
      if (nextOptions) box.options = nextOptions;
      box.table = packNames(next, box.options.overrides ?? []);
    },
  };
  return box;
}

/** Built-in spec the session registers; `state` is the packed table tests inspect. */
export function menuPlugin(
  compiled: CompiledShortcuts,
  options: MenuOptions = {},
): {
  readonly id: string;
  readonly builtin: true;
  readonly factory: PluginFactory;
  readonly state: MenuState;
} {
  const state = createMenuState(compiled, options);
  return {
    id: MENU_ID,
    builtin: true,
    factory: () => createPlugin(state),
    state,
  };
}

/** Conformance/factory entry: settings.replacements, else the six C5–C7 fixtures. */
export const menuFactory: PluginFactory = (settings) => {
  const options = optionsFrom(settings);
  return createPlugin(createMenuState(compiledFrom(settings), options));
};

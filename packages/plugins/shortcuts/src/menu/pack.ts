// Packed shortcut names for the `;` menu. Recompute from this table on every
// change (no narrowing state). Lookups are counted so closed-menu keys can
// prove they did none (docs/plan/16 E12).

import type { CompiledShortcuts, ShortcutSource } from '../compile.ts';
import { listShortcuts, type ShortcutListItem } from '../list.ts';

export const MENU_ROWS = 8;

export interface PackedEntry {
  readonly name: string;
  readonly key: string;
  readonly compact: string;
  readonly firstLine: string;
  readonly source: ShortcutSource;
  readonly override: boolean;
}

export interface RankedRow {
  readonly entry: PackedEntry;
  readonly tier: number;
}

export interface NameTable {
  readonly entries: readonly PackedEntry[];
  readonly expansions: Readonly<Record<string, string>>;
  lookups: number;
}

export function compactName(name: string): string {
  let out = '';
  const lower = name.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const ch = lower.charCodeAt(i);
    const digit = ch >= 48 && ch <= 57;
    const letter = ch >= 97 && ch <= 122;
    if (digit || letter) out += lower[i];
  }
  return out;
}

export function displayName(name: string): string {
  return name.startsWith(';') ? name : `;${name}`;
}

function keyOf(name: string): string {
  return name.startsWith(';') ? name.slice(1) : name;
}

function expansionsOf(compiled: CompiledShortcuts): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [name, text] of Object.entries(compiled.inline.entries)) out[name] = text;
  for (const [name, text] of Object.entries(compiled.long)) out[name] = text;
  return out;
}

function packItem(item: ShortcutListItem, overrides: ReadonlySet<string>): PackedEntry {
  return {
    name: item.name,
    key: keyOf(item.name),
    compact: compactName(keyOf(item.name)),
    firstLine: item.firstLine,
    source: item.source,
    override: overrides.has(item.name) || overrides.has(keyOf(item.name)),
  };
}

function compareEntries(a: PackedEntry, b: PackedEntry): number {
  if (a.source !== b.source) return a.source === 'project' ? -1 : 1;
  if (a.name.length !== b.name.length) return a.name.length - b.name.length;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/** Frozen name table; call `filterNames` to search, which increments `lookups`. */
export function packNames(compiled: CompiledShortcuts, overrides: readonly string[] = []): NameTable {
  const overrideSet = new Set(overrides);
  const entries = listShortcuts(compiled)
    .map((item) => packItem(item, overrideSet))
    .sort(compareEntries);
  return { entries, expansions: expansionsOf(compiled), lookups: 0 };
}

function matchTier(entry: PackedEntry, query: string, compact: string): number | null {
  if (entry.name === query || entry.key === query) return 0;
  if (entry.name.startsWith(query) || entry.key.startsWith(query)) return 1;
  if (compact.length > 0 && entry.compact.startsWith(compact)) return 2;
  if (query.length > 0 && (entry.name.includes(query) || entry.key.includes(query))) return 3;
  if (query.length > 0) {
    for (const word of entry.firstLine.split(/\s+/)) {
      if (word.startsWith(query)) return 4;
    }
  }
  return null;
}

function compareRows(a: RankedRow, b: RankedRow): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  return compareEntries(a.entry, b.entry);
}

/** Best tier per name, then the tie order, capped at `limit`. Empty query is prefix-of-everything. */
export function filterNames(table: NameTable, query: string, limit = MENU_ROWS): RankedRow[] {
  table.lookups++;
  if (query.length === 0) {
    return table.entries.slice(0, limit).map((entry) => ({ entry, tier: 1 }));
  }
  const compact = compactName(query);
  const ranked: RankedRow[] = [];
  for (const entry of table.entries) {
    const tier = matchTier(entry, query, compact);
    if (tier === null) continue;
    ranked.push({ entry, tier });
  }
  ranked.sort(compareRows);
  return ranked.slice(0, limit);
}

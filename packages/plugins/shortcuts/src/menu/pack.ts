// Packed shortcut names for the `;` menu. Recompute from this table on every
// change (no narrowing state). Lookups are counted so closed-menu keys can
// prove they did none (docs/plan/16 E12).

import type { CompiledShortcuts, ShortcutSource } from '../compile.ts';
import { listShortcuts, type ShortcutListItem } from '../list.ts';

export const MENU_ROWS = 8;
/** Template picker cap (opencode-snippets, phase 37). */
export const TEMPLATE_ROWS = 10;

export interface PackedEntry {
  readonly name: string;
  readonly key: string;
  readonly compact: string;
  readonly firstLine: string;
  readonly source: ShortcutSource;
  readonly override: boolean;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly fields: readonly string[];
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
    description: item.description ?? '',
    aliases: item.aliases,
    fields: item.fields,
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

function subsequenceTier(haystack: string, needle: string): number | null {
  if (needle.length === 0) return null;
  let i = 0;
  let start = -1;
  let gaps = 0;
  for (let h = 0; h < haystack.length && i < needle.length; h++) {
    if (haystack[h] === needle[i]) {
      if (start < 0) start = h;
      i++;
    } else if (start >= 0) gaps++;
  }
  if (i < needle.length || start < 0) return null;
  const L = Math.max(haystack.length, 1);
  return 6 + Math.min(0.99, (0.8 * start) / L + (0.19 * gaps) / L);
}

function matchTemplateTier(entry: PackedEntry, query: string, compact: string): number | null {
  let best: number | null = null;
  const consider = (tier: number) => {
    if (best === null || tier < best) best = tier;
  };
  const names = [entry.name, entry.key, ...entry.aliases];
  const q = query.toLowerCase();
  for (const name of names) {
    const key = name.startsWith(';') ? name.slice(1) : name;
    const folded = key.toLowerCase();
    const compactKey = compactName(key);
    if (name === query || key === query || folded === q) consider(0);
    else if (compact.length > 0 && compactKey === compact) consider(1);
    else if (name.startsWith(query) || key.startsWith(query) || folded.startsWith(q)) consider(2);
    else if (compact.length > 0 && compactKey.startsWith(compact)) consider(3);
    else if (query.length > 0 && (name.includes(query) || key.includes(query) || folded.includes(q))) consider(4);
    else if (compact.length > 0 && compactKey.includes(compact)) consider(5);
    else {
      const sub = subsequenceTier(folded, q);
      if (sub !== null) consider(sub);
    }
  }
  if (entry.description && query.length > 0) {
    const d = entry.description.toLowerCase();
    if (d.split(/\s+/).some((word) => word.startsWith(q))) consider(7);
    else if (d.includes(q)) consider(8);
  }
  return best;
}

export function tableHasTemplates(table: NameTable): boolean {
  return table.entries.some((e) => e.description.length > 0 || e.aliases.length > 0 || e.fields.length > 0);
}

/** opencode-snippets tiers 0–8; ties project before personal, then name. */
export function rankTemplates(table: NameTable, query: string, limit = TEMPLATE_ROWS): RankedRow[] {
  table.lookups++;
  if (query.length === 0) {
    return table.entries.slice(0, limit).map((entry) => ({ entry, tier: 2 }));
  }
  const compact = compactName(query);
  const ranked: RankedRow[] = [];
  for (const entry of table.entries) {
    const tier = matchTemplateTier(entry, query, compact);
    if (tier === null) continue;
    ranked.push({ entry, tier });
  }
  ranked.sort(compareRows);
  return ranked.slice(0, limit);
}

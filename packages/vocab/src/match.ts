// Ranking for project-name search (r9 matcher.mjs, r13 native-matcher).
// Native retrieval returns ≤ 96 trigram candidates; this module gates,
// scores tiers 0–3, and sorts. Never suggests an exact name or English prose.

import { splitWords } from './split.ts';

export const MAX_QUERY_UNITS = 256;
export const NATIVE_CANDIDATES = 96;
export const MENU_ROWS = 8;
export const NATIVE_BUDGET_US = 300;
export const TOTAL_BUDGET_MS = 1.8;

const CODE_MARK = /`|_|::|\.|\(\)|\//;
const CAMEL = /[\p{Ll}\p{Lo}\p{M}\p{N}][\p{Lu}]|[\p{Lu}]{2,}[\p{Ll}]/u;

/** Same `codeLike` as the coordinator (`@murmo/core` `isCodeLike`). */
export function isCodeLike(token: string): boolean {
  return CODE_MARK.test(token) || CAMEL.test(token);
}

/** Strip surrounding backticks and a trailing `()`. */
export function bareName(token: string): string {
  return token.replace(/^`|`$/g, '').replace(/\(\)$/, '');
}

/** Lowercase word key: `OutboxWorker` and `outbox_worker` share `outbox worker`. */
export function wordKey(input: string): string {
  return splitWords(input).join(' ');
}

let rowA = new Uint16Array(256);
let rowB = new Uint16Array(256);

/** Bounded Levenshtein; returns `limit+1` when the distance exceeds `limit`. */
export function editDistance(a: string, b: string, limit = 2): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  if (b.length + 2 > rowA.length) {
    const n = 2 ** Math.ceil(Math.log2(b.length + 2));
    rowA = new Uint16Array(n);
    rowB = new Uint16Array(n);
  }
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const lo = Math.max(1, i - limit);
    const hi = Math.min(b.length, i + limit);
    if (lo > 1) cur[lo - 1] = limit + 1;
    let min = i;
    for (let j = lo; j <= hi; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      min = Math.min(min, cur[j] ?? 0);
    }
    if (hi < b.length) cur[hi + 1] = limit + 1;
    if (min > limit) return limit + 1;
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[b.length] ?? limit + 1;
}

export interface NameLocation {
  readonly kind: string;
  readonly file: string;
  readonly line: number;
}

export interface NameCandidate {
  readonly id: number;
  readonly name: string;
  readonly key: string;
  readonly refs: number;
  readonly location: NameLocation;
  readonly locations: number;
  readonly member: string;
}

export interface RankedName {
  readonly id: number;
  readonly name: string;
  /** 0 same words, 1 one edit, 2 two edits, 3 owner/member fallback. */
  readonly score: number;
  readonly refs: number;
  readonly location: NameLocation;
  readonly locations: number;
}

export interface RankOptions {
  readonly isEnglish?: (word: string) => boolean;
  readonly exactName?: (name: string) => boolean;
}

function memberKey(name: string): string {
  const parts = name.split(/::|\./);
  return wordKey(parts[parts.length - 1] ?? name);
}

/**
 * Gate then score. `candidates` are the native (or JS) trigram hits, already
 * capped at 96. Returns at most `MENU_ROWS` after sort.
 */
export function rankNames(
  token: string,
  candidates: readonly NameCandidate[],
  options: RankOptions = {},
): RankedName[] {
  const name = bareName(token);
  if (!isCodeLike(token) || name.length === 0) return [];
  if ([...name].length > MAX_QUERY_UNITS) return [];
  if (options.exactName?.(name)) return [];
  if (options.isEnglish?.(name.toLowerCase())) return [];
  const k = wordKey(name);
  const out: RankedName[] = [];
  for (const candidate of candidates) {
    const d = editDistance(k, candidate.key, 2);
    if (d > 2) continue;
    out.push({
      id: candidate.id,
      name: candidate.name,
      score: d,
      refs: candidate.refs,
      location: candidate.location,
      locations: candidate.locations,
    });
  }
  if (!out.length && /::|\./.test(name)) {
    const member = memberKey(name);
    for (const candidate of candidates) {
      if (candidate.member !== member && wordKey(candidate.name) !== member) continue;
      out.push({
        id: candidate.id,
        name: candidate.name,
        score: 3,
        refs: candidate.refs,
        location: candidate.location,
        locations: candidate.locations,
      });
    }
  }
  out.sort((a, b) => a.score - b.score || b.refs - a.refs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out.slice(0, MENU_ROWS);
}

export function formatNameRow(row: RankedName): string {
  const loc = row.location;
  return `${row.name}  ${loc.kind}  ${loc.file}:${loc.line}`;
}

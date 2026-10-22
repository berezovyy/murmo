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
  readonly source?: number;
}

export interface RankedName {
  readonly id: number;
  readonly name: string;
  /** 0 same words, 1 one edit, 2 two edits, 3 owner/member fallback. Alias: 0 exact, 1 subset, 2 typo. */
  readonly score: number;
  readonly refs: number;
  readonly location: NameLocation;
  readonly locations: number;
  readonly source?: number;
}

export const SOURCE_USER = 1;
export const SOURCE_MANIFEST = 2;
export const SOURCE_TAGS = 4;
export const SOURCE_LSP = 8;
export const SOURCE_DOCS = 16;

export function sourceRank(bits: number): number {
  if (bits & SOURCE_USER) return 0;
  if (bits & SOURCE_MANIFEST) return 1;
  if (bits & SOURCE_TAGS) return 2;
  if (bits & SOURCE_LSP) return 3;
  if (bits & SOURCE_DOCS) return 4;
  return 5;
}

export function sourceLabel(bits: number | undefined): string {
  if (!bits) return '';
  const rank = sourceRank(bits);
  if (rank === 3) return 'LSP';
  if (rank === 4) return 'docs';
  return '';
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'for',
  'on',
  'at',
  'by',
  'and',
  'or',
  'is',
  'are',
  'was',
  'were',
  'be',
  'this',
  'that',
  'with',
  'from',
  'as',
  'it',
  'its',
  'into',
  'than',
  'then',
  'so',
  'if',
  'not',
  'no',
  'do',
  'does',
  'did',
  'can',
  'we',
  'you',
  'i',
  'they',
  'their',
  'our',
  'your',
  'but',
  'about',
  'please',
  'review',
]);

export interface ProseSpan {
  readonly start: number;
  readonly end: number;
  readonly words: readonly string[];
  readonly key: string;
}

/** Last 1–4 non-stopword tokens before `cursor`. */
export function proseSpan(text: string, cursor: number): ProseSpan | null {
  const prefix = text.slice(0, cursor);
  const tokens: { start: number; end: number; word: string }[] = [];
  const re = /[^\s]+/g;
  for (const m of prefix.matchAll(re)) {
    const word = m[0] ?? '';
    tokens.push({ start: m.index, end: m.index + word.length, word });
  }
  const kept: { start: number; end: number; word: string }[] = [];
  for (let i = tokens.length - 1; i >= 0 && kept.length < 4; i--) {
    const tok = tokens[i];
    if (!tok) continue;
    const bare = tok.word.replace(/^;+/, '').replace(/[.,:;!?]+$/g, '');
    if (!bare) continue;
    const parts = splitWords(bare);
    const usable = parts.length ? parts : [bare.toLowerCase()];
    for (let p = usable.length - 1; p >= 0 && kept.length < 4; p--) {
      const w = usable[p] ?? '';
      if (!w || STOPWORDS.has(w)) continue;
      kept.push({ start: tok.start, end: tok.end, word: w });
    }
  }
  kept.reverse();
  if (!kept.length) return null;
  const words = kept.map((t) => t.word);
  return {
    start: kept[0]?.start ?? 0,
    end: kept[kept.length - 1]?.end ?? cursor,
    words,
    key: words.join(' '),
  };
}

export interface RankOptions {
  readonly isEnglish?: (word: string) => boolean;
  readonly exactName?: (name: string) => boolean;
}

function rankedOf(candidate: NameCandidate, score: number): RankedName {
  return {
    id: candidate.id,
    name: candidate.name,
    score,
    refs: candidate.refs,
    location: candidate.location,
    locations: candidate.locations,
    ...(candidate.source !== undefined ? { source: candidate.source } : {}),
  };
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
    out.push(rankedOf(candidate, d));
  }
  if (!out.length && /::|\./.test(name)) {
    const member = memberKey(name);
    for (const candidate of candidates) {
      if (candidate.member !== member && wordKey(candidate.name) !== member) continue;
      out.push(rankedOf(candidate, 3));
    }
  }
  out.sort((a, b) => a.score - b.score || b.refs - a.refs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out.slice(0, MENU_ROWS);
}

function aliasScore(query: readonly string[], candidateKey: string): number | null {
  const cand = candidateKey.split(' ').filter(Boolean);
  if (!query.length || !cand.length) return null;
  if (query.join(' ') === candidateKey) return 0;
  if (query.every((q) => cand.includes(q))) return 1;
  if (query.length === cand.length && query.every((q, i) => editDistance(q, cand[i] ?? '', 1) <= 1)) return 2;
  if (query.every((q) => cand.some((c) => editDistance(q, c, 1) <= 1))) return 2;
  return null;
}

/**
 * Prose alias ranking: exact word-key, then subset, then 1-edit per word.
 * Ties go to source rank, then refs. At most `MENU_ROWS`.
 */
export function rankAliases(query: readonly string[], candidates: readonly NameCandidate[]): RankedName[] {
  if (!query.length) return [];
  const seen = new Set<string>();
  const out: RankedName[] = [];
  for (const candidate of candidates) {
    const score = aliasScore(query, candidate.key);
    if (score === null) continue;
    if (seen.has(candidate.name)) continue;
    seen.add(candidate.name);
    out.push(rankedOf(candidate, score));
  }
  out.sort(
    (a, b) =>
      a.score - b.score ||
      sourceRank(a.source ?? SOURCE_TAGS) - sourceRank(b.source ?? SOURCE_TAGS) ||
      b.refs - a.refs ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return out.slice(0, MENU_ROWS);
}

export function formatNameRow(row: RankedName): string {
  const loc = row.location;
  const from = sourceLabel(row.source);
  const extra = from ? `  from ${from}` : '';
  return `${row.name}  ${loc.kind}  ${loc.file}:${loc.line}${extra}`;
}

export function formatPathInsert(name: string, file: string): string {
  return `${name} (\`${file}\`)`;
}

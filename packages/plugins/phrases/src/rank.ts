// Explainable ranking: prefix, then scope, then count×recency plus an
// acceptance bonus. Ordered fixtures pin the order (E24, E25).

export const DAY_MS = 86_400_000;
export const RECENCY_HALF_LIFE_MS = 7 * DAY_MS;
export const MIN_COUNT = 3;
export const HIDE_DISMISSALS = 3;
export const OFFER_COUNT = 5;
export const OFFER_WINDOW_MS = 14 * DAY_MS;
export const ACCEPT_BONUS = 0.25;

export type PhraseScope = 'project' | 'host' | 'global';

export interface PhraseRecord {
  readonly id: string;
  readonly phrase: string;
  readonly host: string;
  readonly project: string;
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly accepts: number;
  readonly dismissals: number;
  /** Timestamps of learn events, newest last; used only for the shortcut offer. */
  readonly recentAt: readonly number[];
}

export interface RankQuery {
  readonly prefix: string;
  readonly host: string;
  readonly project: string;
  readonly now: number;
  readonly minCount?: number;
}

export interface RankedPhrase {
  readonly record: PhraseRecord;
  readonly scope: PhraseScope;
  readonly score: number;
  readonly suffix: string;
  readonly offerShortcut: boolean;
}

export function recencyWeight(ageMs: number): number {
  if (ageMs <= 0) return 1;
  return 0.25 + 0.75 * Math.exp(-ageMs / RECENCY_HALF_LIFE_MS);
}

export function countScore(count: number): number {
  return Math.log2(1 + Math.max(0, count));
}

export function scopeOf(record: PhraseRecord, query: Pick<RankQuery, 'host' | 'project'>): PhraseScope {
  if (record.project === query.project) return 'project';
  if (record.host === query.host) return 'host';
  return 'global';
}

const SCOPE_TIER: Record<PhraseScope, number> = { project: 0, host: 1, global: 2 };

export function isHidden(record: PhraseRecord, minCount = MIN_COUNT): boolean {
  if (record.count < minCount) return true;
  return record.dismissals >= HIDE_DISMISSALS && record.accepts === 0;
}

export function offerShortcut(record: PhraseRecord, now: number): boolean {
  const since = now - OFFER_WINDOW_MS;
  let n = 0;
  for (const at of record.recentAt) if (at >= since) n++;
  return n >= OFFER_COUNT;
}

export function rankScore(record: PhraseRecord, now: number): number {
  return countScore(record.count) * recencyWeight(now - record.lastAt) + ACCEPT_BONUS * record.accepts;
}

function suffixOf(phrase: string, prefix: string): string {
  return phrase.startsWith(prefix) ? phrase.slice(prefix.length) : '';
}

/**
 * Prefix matches, drop hidden, keep the best-scope record per phrase, then
 * order by scope, score, phrase. A candidate that would change typed text
 * (prefix not an exact leading slice) never appears.
 */
export function rankPhrases(records: readonly PhraseRecord[], query: RankQuery): RankedPhrase[] {
  const minCount = query.minCount ?? MIN_COUNT;
  const prefix = query.prefix;
  if (prefix.length === 0) return [];
  const best = new Map<string, RankedPhrase>();
  for (const record of records) {
    if (!record.phrase.startsWith(prefix)) continue;
    if (record.phrase === prefix) continue;
    if (isHidden(record, minCount)) continue;
    const scope = scopeOf(record, query);
    const ranked: RankedPhrase = {
      record,
      scope,
      score: rankScore(record, query.now),
      suffix: suffixOf(record.phrase, prefix),
      offerShortcut: offerShortcut(record, query.now),
    };
    const prev = best.get(record.phrase);
    if (!prev || better(ranked, prev) < 0) best.set(record.phrase, ranked);
  }
  return [...best.values()].sort(better);
}

/** Negative when `a` should sort before `b`. */
export function better(a: RankedPhrase, b: RankedPhrase): number {
  const scope = SCOPE_TIER[a.scope] - SCOPE_TIER[b.scope];
  if (scope !== 0) return scope;
  if (b.score !== a.score) return b.score - a.score;
  if (a.record.phrase < b.record.phrase) return -1;
  if (a.record.phrase > b.record.phrase) return 1;
  return 0;
}

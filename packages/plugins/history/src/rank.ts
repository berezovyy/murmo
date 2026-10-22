// r9 score, kept explainable (E3): average best word-prefix quality ×
// (0.25 + 0.75·exp(−age/7d)) × log2(1+count), then a this-repo boost.

import { utf8Encode } from '@murmo/store';
import { isWordByte, tokens } from './tokens.ts';

export const HALF_LIFE_SEC = 7 * 86_400;
/** Added to the r9 score so this-repository matches sort first. */
export const SCOPE_BOOST = 1_000;
export const TOP = 10;
export const HOSTS = ['claude', 'codex', 'opencode', 'pi', 'fake'] as const;
export type HistoryHost = (typeof HOSTS)[number];

export interface HistoryEvent {
  readonly host: string;
  readonly project: string;
  readonly at: number;
}

export interface HistoryRecord {
  readonly id: number;
  readonly text: string;
  readonly count: number;
  readonly lastAt: number;
  readonly events: readonly HistoryEvent[];
}

export interface RankQuery {
  readonly query: string;
  readonly project?: string;
  readonly host?: string;
  readonly now: number;
}

export interface RankedHit {
  readonly id: number;
  readonly score: number;
  readonly text: string;
}

export function hostIndex(host: string): number {
  const i = (HOSTS as readonly string[]).indexOf(host);
  return i < 0 ? HOSTS.length - 1 : i;
}

export function recencyCount(count: number, lastAtMs: number, nowMs: number): number {
  const ageSec = Math.max(0, (nowMs - lastAtMs) / 1000);
  return Math.fround((0.25 + 0.75 * Math.exp(-ageSec / HALF_LIFE_SEC)) * Math.log2(1 + count));
}

export function prefixQuality(qLen: number, wordLen: number): number {
  return wordLen <= 0 ? 0 : Math.floor((100 * qLen) / wordLen);
}

function bestPrefixQuality(hayUtf8: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  let best = 0;
  const n = hayUtf8.length;
  const qn = needle.length;
  for (let pos = 0; pos + qn <= n; pos++) {
    if (pos > 0 && isWordByte(hayUtf8[pos - 1] as number)) continue;
    let ok = true;
    for (let i = 0; i < qn; i++) {
      if (hayUtf8[pos + i] !== needle[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let end = pos + qn;
    while (end < n && isWordByte(hayUtf8[end] as number)) end++;
    const quality = prefixQuality(qn, end - pos);
    if (quality > best) best = quality;
  }
  return best;
}

export function bruteScore(
  record: HistoryRecord,
  queryTokens: readonly string[],
  nowMs: number,
  project?: string,
): number {
  if (queryTokens.length === 0) return 0;
  const hay = utf8Encode(record.text.normalize('NFC').toLowerCase());
  let quality = 0;
  for (const token of queryTokens) {
    const q = utf8Encode(token);
    const best = bestPrefixQuality(hay, q);
    if (best === 0) return 0;
    quality += best;
  }
  let score = (quality / (100 * queryTokens.length)) * recencyCount(record.count, record.lastAt, nowMs);
  if (project !== undefined && record.events.some((e) => e.project === project)) score += SCOPE_BOOST;
  return score;
}

export function insertTop(best: RankedHit[], hit: RankedHit, cap = TOP): void {
  for (let k = 0; k < best.length; k++) {
    if ((best[k] as RankedHit).id === hit.id) {
      if (hit.score <= (best[k] as RankedHit).score) return;
      best.splice(k, 1);
      break;
    }
  }
  let i = best.length;
  while (
    i > 0 &&
    (hit.score > (best[i - 1] as RankedHit).score ||
      (hit.score === (best[i - 1] as RankedHit).score && hit.id < (best[i - 1] as RankedHit).id))
  ) {
    i--;
  }
  if (i < cap) {
    best.splice(i, 0, hit);
    if (best.length > cap) best.pop();
  }
}

/** Linear scan used as the oracle for packed search (the 29-query fixture). */
export function bruteSearch(records: readonly HistoryRecord[], query: RankQuery): RankedHit[] {
  const qs = tokens(query.query);
  const best: RankedHit[] = [];
  if (qs.length === 0) {
    const recent = [...records].sort((a, b) => b.lastAt - a.lastAt || a.id - b.id).slice(0, TOP);
    for (const r of recent) best.push({ id: r.id, score: r.lastAt, text: r.text });
    return best;
  }
  if (qs.length > 32) return [];
  for (const record of records) {
    const score = bruteScore(record, qs, query.now, query.project);
    if (score <= 0) continue;
    insertTop(best, { id: record.id, score, text: record.text });
  }
  return best;
}

// In-memory history: packed snapshot plus a ≤256-entry unmerged delta.
// Lookups are counted so closed-menu keys can prove they did none (E9).

import { sha256Hex, utf8Encode } from '@murmo/store';
import { mapPacked, type PackedIndex, packedBytes, searchPacked } from './packed.ts';
import { bruteSearch, type HistoryRecord, insertTop, type RankedHit, type RankQuery, TOP } from './rank.ts';

export const DELTA_CAP = 256;

export interface LearnEvent {
  readonly text: string;
  readonly host: string;
  readonly project: string;
  readonly at: number;
}

export interface HistoryStore {
  lookups: number;
  record(events: readonly LearnEvent[]): void;
  search(query: RankQuery): RankedHit[];
  records(): HistoryRecord[];
  load(records: readonly HistoryRecord[]): void;
  attachPacked(index: PackedIndex | null): void;
  packed: PackedIndex | null;
  delta: HistoryRecord[];
  bytes(): number;
}

export function promptId(text: string): string {
  return sha256Hex(utf8Encode(text)).slice(0, 16);
}

export function createMemoryStore(): HistoryStore {
  const byText = new Map<string, HistoryRecord>();
  let nextId = 0;
  let packed: PackedIndex | null = null;
  const delta: HistoryRecord[] = [];
  const store: HistoryStore = {
    lookups: 0,
    packed: null,
    delta,
    record(events) {
      for (const ev of events) {
        const existing = byText.get(ev.text);
        if (existing) {
          const updated: HistoryRecord = {
            ...existing,
            count: existing.count + 1,
            lastAt: Math.max(existing.lastAt, ev.at),
            events: [...existing.events, { host: ev.host, project: ev.project, at: ev.at }],
          };
          byText.set(ev.text, updated);
          const di = delta.findIndex((r) => r.text === ev.text);
          if (di >= 0) delta[di] = updated;
          else if (delta.length < DELTA_CAP) delta.push(updated);
        } else {
          const rec: HistoryRecord = {
            id: nextId++,
            text: ev.text,
            count: 1,
            lastAt: ev.at,
            events: [{ host: ev.host, project: ev.project, at: ev.at }],
          };
          byText.set(ev.text, rec);
          if (delta.length < DELTA_CAP) delta.push(rec);
        }
      }
    },
    search(query) {
      store.lookups++;
      const packedHits = packed
        ? searchPacked(
            packed,
            query.query,
            query.project === undefined ? { now: query.now } : { now: query.now, project: query.project },
          )
        : [];
      const deltaHits = bruteSearch(delta, query);
      if (packedHits.length === 0) return deltaHits;
      if (deltaHits.length === 0) return packedHits;
      const best: RankedHit[] = [];
      const seen = new Set<string>();
      for (const hit of [...packedHits, ...deltaHits]) {
        if (seen.has(hit.text)) continue;
        seen.add(hit.text);
        insertTop(best, hit, TOP);
      }
      return best;
    },
    records() {
      return [...byText.values()].sort((a, b) => a.id - b.id);
    },
    load(records) {
      byText.clear();
      delta.length = 0;
      nextId = 0;
      for (const r of records) {
        byText.set(r.text, r);
        if (r.id >= nextId) nextId = r.id + 1;
      }
    },
    attachPacked(index) {
      packed = index;
      store.packed = index;
    },
    bytes() {
      return packed ? packedBytes(packed).total : 0;
    },
  };
  return store;
}

export function mapFiles(files: Readonly<Record<string, Uint8Array>>): PackedIndex | null {
  return mapPacked(files);
}

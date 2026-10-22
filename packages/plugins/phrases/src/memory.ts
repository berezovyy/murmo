// In-memory phrase store. The Node backend persists the same records through
// the log and packed snapshot; tests and the isolated factory use this alone.

import { sha256Hex, utf8Encode } from '@murmo/store';
import { emptyMetrics, type PhraseMetrics } from './metrics.ts';
import { MIN_COUNT, type PhraseRecord, type RankedPhrase, type RankQuery, rankPhrases, rankScore } from './rank.ts';

export interface LearnEvent {
  readonly phrase: string;
  readonly host: string;
  readonly project: string;
  readonly at: number;
}

export interface PhraseStore {
  learn(events: readonly LearnEvent[]): number;
  lookup(query: RankQuery): readonly RankedPhrase[];
  recordAccept(phrase: string, host: string, project: string, now: number): void;
  recordDismiss(phrase: string, host: string, project: string, now: number): void;
  list(filter?: { readonly project?: string }): readonly PhraseRecord[];
  forget(id: string): number;
  wipe(filter?: { readonly project?: string }): number;
  records(): readonly PhraseRecord[];
  load(records: readonly PhraseRecord[]): void;
  readonly metrics: PhraseMetrics;
}

const RECENT_KEEP = 32;

function keyOf(phrase: string, host: string, project: string): string {
  return `${phrase}\u0000${host}\u0000${project}`;
}

export function phraseId(phrase: string): string {
  return sha256Hex(utf8Encode(phrase)).slice(0, 16);
}

function pushRecent(list: readonly number[], at: number): number[] {
  const next = list.length >= RECENT_KEEP ? list.slice(list.length - RECENT_KEEP + 1) : [...list];
  next.push(at);
  return next;
}

export function createMemoryStore(): PhraseStore {
  const byKey = new Map<string, PhraseRecord>();
  const metrics = emptyMetrics();

  const upsert = (
    phrase: string,
    host: string,
    project: string,
    patch: (current: PhraseRecord | undefined) => PhraseRecord | undefined,
  ): void => {
    const key = keyOf(phrase, host, project);
    const next = patch(byKey.get(key));
    if (next) byKey.set(key, next);
    else byKey.delete(key);
  };

  const store: PhraseStore = {
    metrics,
    learn(events) {
      let n = 0;
      for (const event of events) {
        if (event.phrase.length === 0) continue;
        upsert(event.phrase, event.host, event.project, (current) => {
          if (!current) {
            return {
              id: phraseId(event.phrase),
              phrase: event.phrase,
              host: event.host,
              project: event.project,
              count: 1,
              firstAt: event.at,
              lastAt: event.at,
              accepts: 0,
              dismissals: 0,
              recentAt: [event.at],
            };
          }
          return {
            ...current,
            count: current.count + 1,
            lastAt: event.at,
            recentAt: pushRecent(current.recentAt, event.at),
          };
        });
        n++;
      }
      return n;
    },
    lookup(query) {
      return rankPhrases([...byKey.values()], query);
    },
    recordAccept(phrase, host, project, now) {
      upsert(phrase, host, project, (current) =>
        current ? { ...current, accepts: current.accepts + 1, lastAt: now } : current,
      );
      metrics.accepted++;
    },
    recordDismiss(phrase, host, project, now) {
      upsert(phrase, host, project, (current) =>
        current ? { ...current, dismissals: current.dismissals + 1, lastAt: now } : current,
      );
      metrics.dismissed++;
    },
    list(filter) {
      const rows = [...byKey.values()].filter((r) => !filter?.project || r.project === filter.project);
      return rows.sort((a, b) => b.lastAt - a.lastAt || (a.phrase < b.phrase ? -1 : 1));
    },
    forget(id) {
      let removed = 0;
      for (const [key, record] of byKey) {
        if (record.id === id || record.phrase === id) {
          byKey.delete(key);
          removed++;
        }
      }
      return removed;
    },
    wipe(filter) {
      if (!filter?.project) {
        const n = byKey.size;
        byKey.clear();
        return n;
      }
      let removed = 0;
      for (const [key, record] of byKey) {
        if (record.project === filter.project) {
          byKey.delete(key);
          removed++;
        }
      }
      return removed;
    },
    records() {
      return [...byKey.values()];
    },
    load(records) {
      byKey.clear();
      for (const record of records) byKey.set(keyOf(record.phrase, record.host, record.project), record);
    },
  };
  return store;
}

export function packedRowsOf(
  records: readonly PhraseRecord[],
  now: number,
): { key: string; value: string; score: number }[] {
  const groups = new Map<string, PhraseRecord[]>();
  for (const record of records) {
    const list = groups.get(record.phrase) ?? [];
    list.push(record);
    groups.set(record.phrase, list);
  }
  return [...groups.entries()].map(([phrase, list]) => ({
    key: phrase,
    value: JSON.stringify(list),
    score: Math.max(0, Math.round(Math.max(...list.map((r) => rankScore(r, now))) * 1000)),
  }));
}

export { MIN_COUNT };

// Closed-menu gate (E9): 1,000,000 ordinary keys must not call search.

import type { HistoryStore } from './memory.ts';
import type { RankedHit, RankQuery } from './rank.ts';

export function searchIfOpen(open: boolean, store: HistoryStore, query: RankQuery): RankedHit[] {
  if (!open) return [];
  return store.search(query);
}

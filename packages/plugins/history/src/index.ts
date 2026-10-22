// Built-in `history` plugin: one prompt history across agents (docs/plan/35).
// Packed snapshot and log persistence are `@murmo/plugin-history/node`.

export type { HistoryStore, LearnEvent } from './memory.ts';
export { createMemoryStore, DELTA_CAP, promptId } from './memory.ts';
export type { HistoryMetrics } from './metrics.ts';
export { emptyMetrics, formatDoctorStats } from './metrics.ts';
export type { PackedFiles, PackedIndex } from './packed.ts';
export { buildPacked, HISTORY_FORMAT, loadText, mapPacked, packedBytes, searchPacked, TEXT_CHUNK } from './packed.ts';
export type { HistoryOptions } from './plugin.ts';
export {
  createHistoryPlugin,
  DEBOUNCE_MS,
  DEFAULT_ROW_CELLS,
  doctorLine,
  HISTORY_ID_PLUGIN,
  HISTORY_MANIFEST,
  HISTORY_ROWS,
  HISTORY_VERSION,
  historyFactory,
  historyFactory as default,
  historyPlugin,
} from './plugin.ts';
export type { HistoryEvent, HistoryHost, HistoryRecord, RankedHit, RankQuery } from './rank.ts';
export {
  bruteScore,
  bruteSearch,
  HALF_LIFE_SEC,
  HOSTS,
  hostIndex,
  insertTop,
  prefixQuality,
  recencyCount,
  SCOPE_BOOST,
  TOP,
} from './rank.ts';
export type { RecordDecision, RecordInput, SkipReason } from './record.ts';
export { decideFromCommitted, decideRecord, MAX_TEXT_BYTES, spansCover } from './record.ts';
export { searchIfOpen } from './search.ts';
export type { HistorySettings } from './settings.ts';
export { resolveHistorySettings } from './settings.ts';
export { tokens } from './tokens.ts';
export type { HistoryTrigger } from './trigger.ts';
export { findHistoryTrigger } from './trigger.ts';

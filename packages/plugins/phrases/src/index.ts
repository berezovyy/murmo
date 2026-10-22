// Built-in `phrases` plugin: learner, ranker and ghost provider on the public
// API (docs/plan/34). Packed index and log persistence are `@murmo/plugin-phrases/node`.

export type { ClauseSpan, ExtractInput, ExtractResult, SkipReason } from './extract.ts';
export {
  extractClauseSpans,
  extractClauses,
  learnFromCommitted,
  learnFromSubmit,
  maskNonProse,
  spansCover,
} from './extract.ts';
export type { GateInput, GateReason, GhostRoute } from './gates.ts';
export {
  ghostGates,
  ghostRoute,
  lastLine,
  MAX_PREFIX_WORDS,
  MIN_PREFIX_WORDS,
  PAUSE_MS,
  prefixCandidates,
  prefixWords,
} from './gates.ts';
export type { VisibleGhost } from './ghost.ts';
export { clipGhost, firstGrapheme, makeVisible, remainingCells, sliceMatching } from './ghost.ts';
export type { LearnEvent, PhraseStore } from './memory.ts';
export { createMemoryStore, packedRowsOf, phraseId } from './memory.ts';
export type { PhraseMetrics } from './metrics.ts';
export { emptyMetrics, formatDoctorStats } from './metrics.ts';
export type { PackedIndex, PackedRow } from './packed.ts';
export {
  blockPrefix,
  buildPacked,
  Completion,
  keyAt,
  mapPacked,
  PHRASES_FORMAT,
  prefixRange,
  RevisionGate,
  valueAt,
} from './packed.ts';
export type { PhrasesOptions } from './plugin.ts';
export {
  createPhrasesPlugin,
  DEFAULT_ROW_CELLS,
  doctorLine,
  PHRASES_ID,
  PHRASES_MANIFEST,
  PHRASES_VERSION,
  PRIVATE_STATUS,
  phrasesFactory,
  phrasesFactory as default,
  phrasesPlugin,
} from './plugin.ts';
export type { PhraseRecord, PhraseScope, RankedPhrase, RankQuery } from './rank.ts';
export {
  ACCEPT_BONUS,
  better,
  countScore,
  DAY_MS,
  HIDE_DISMISSALS,
  isHidden,
  MIN_COUNT,
  OFFER_COUNT,
  OFFER_WINDOW_MS,
  offerShortcut,
  RECENCY_HALF_LIFE_MS,
  rankPhrases,
  rankScore,
  recencyWeight,
  scopeOf,
} from './rank.ts';
export { hasRawControl, sanitizeCandidate } from './sanitize.ts';
export type { PhrasesSettings } from './settings.ts';
export { resolvePhrasesSettings } from './settings.ts';
export { defaultCellMeasure } from './width.ts';

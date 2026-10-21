// @murmo/provenance: typed spans, ordered draft deltas and the typed-only view,
// so "only touch what you typed" (vision principle 7) is one implementation
// that the core and all four adapters share (docs/plan/04). Every offset is a
// UTF-16 code unit. Pure functions only; drafts and spans are never mutated.

export {
  applyDelta,
  applyDeltas,
  type Bias,
  coalesce,
  deltaProblem,
  mapPosition,
  mapRange,
  verifyLedger,
} from './deltas.ts';
export {
  addsCoverage,
  applyChange,
  moveCursor,
  type NextDraftOptions,
  nextDraft,
  restoreDraft,
  type TypingRules,
} from './draft.ts';
export { projectTyped, typedProjector } from './project.ts';
export { covers, noSpans, type Spans, splice, validSpans } from './spans.ts';

// @murmo/core: the session between one host adapter and the plugins (docs/plan/05–09).
// Phase 05: draft state, ordered deltas, versioned edits, owned undo, the
// stale-result check, presentation and the fail-open guard. The reference
// adapter, a direct hook runner and a driver live in `@murmo/core/testing`.

export { type Accepted, DraftState, degradeOrigins } from './draft-state.ts';
export {
  attributionLabel,
  type CommitGate,
  type CommitRequest,
  certaintyAllowsEdit,
  type EditDeps,
  Edits,
  editable,
  invalidReason,
  unsupportedReason,
} from './edits.ts';
export { applyEffects, type EffectDeps } from './effects.ts';
export { FAILURE_LIMIT, FailOpen } from './guard.ts';
export {
  disablesPlugin,
  entryOf,
  faultOf,
  type HookCall,
  type HookRunner,
  type HookSnapshot,
  type LoadedPlugin,
  type PluginEntry,
  type RunnerHealth,
} from './hooks.ts';
export { DEFAULT_STATUS_MAX_LENGTH, Presentation, type PresentationDeps, type VisibleGhost } from './present.ts';
export { createSession, KILL_NOTICE, type Session, type SessionOptions } from './session.ts';
export { isCurrent, issueTicket, type SessionView, type StaleReason, staleReason, type Ticket } from './stale.ts';
export { Counters, type PluginHealth, type SessionStats, type Surface } from './stats.ts';
export { restoredExactly, restoreTarget, type UndoGesture, UndoLog, type UndoRecord } from './undo.ts';

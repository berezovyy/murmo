// @murmo/core: the session between one host adapter and the plugins (docs/plan/05–09).
// Phase 05: draft state, ordered deltas, versioned edits, owned undo, the
// stale-result check, presentation and the fail-open guard. Phase 06: key
// router, claim validation, explicit plugin order and the merged menu.
// Phase 07: inline rules on the key path (typos, short shortcuts, `.` waits).
// Phase 08: the before-submit pipeline, guard position, and submit-committed
// delivery. Phase 09: in-process executor, permissions, budgets and
// attribution. The reference adapter, a direct hook runner and a driver live in
// `@murmo/core/testing`.

export {
  createMemoryProjectFiles,
  createMemoryStorage,
  createStorageBroker,
  denyProject,
  type MemoryProjectFile,
  type PluginStorageBroker,
  type StorageBroker,
} from './brokers/index.ts';
export { type ClaimValidation, claimWrites, isSharedKey, type ValidatedClaim, validateClaims } from './claims.ts';
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
export {
  createInlineRewriter,
  createInlineStage,
  DEFAULT_INLINE_MAX_BYTES,
  ENGLISH_POLICY,
  exactLookupPolicy,
  InlineRegistrationError,
  type InlineRewriter,
  type InlineStage,
  MAX_INSERT_BYTES,
  openTable,
  policyByName,
  REQUIRED_SKIP,
  type RegisteredInline,
  receiptForTable,
  registerPolicy,
  registerRuleSet,
  type ShortcutCounts,
  type TableReceipt,
  type WordPolicy,
} from './inline/index.ts';
export { type Decision, KeyRouter, type KeyRouterDeps } from './keys.ts';
export { MENU_MAX_PER_PLUGIN, MENU_WINDOW, Menu, type MenuChoice, type MenuDeps, visibleWindow } from './menu.ts';
export { type PluginOrderCode, PluginOrderError, resolveOrder, uniquePluginIds } from './order.ts';
export {
  type Admission,
  admit,
  attributionGate,
  ChangeCoalescer,
  createPluginHost,
  deadlineFor,
  EditRate,
  type FaultAction,
  FaultBook,
  type GrantMap,
  grantAccess,
  grantedPermissions,
  type HostPluginSpec,
  isGranted,
  type PluginHost,
  type PluginHostOptions,
  permissionGate,
} from './plugins/index.ts';
export { DEFAULT_STATUS_MAX_LENGTH, Presentation, type PresentationDeps, type VisibleGhost } from './present.ts';
export { createSession, KILL_NOTICE, type Session, type SessionOptions } from './session.ts';
export { isCurrent, issueTicket, type SessionView, type StaleReason, staleReason, type Ticket } from './stale.ts';
export { Counters, type DecisionBy, type PluginHealth, type SessionStats, type Surface } from './stats.ts';
export {
  COMMIT_WINDOW_MS,
  COMMITTED_DEDUP,
  declaredAccess,
  type MenuSurface,
  noMenu,
  OBSERVER_QUEUE,
  REWRITE_DIAGNOSTIC,
  runPipeline,
  SUBMIT_DEADLINE_MS,
  type SubmitAccess,
  SubmitController,
  type SubmitControllerDeps,
  type SubmitDecisionCounts,
  submitDeadlineMs,
  submitOptions,
} from './submit/index.ts';
export { restoredExactly, restoreTarget, type UndoGesture, UndoLog, type UndoRecord } from './undo.ts';

// Inline rules on the key path (docs/plan/07): typo fixes and short shortcuts
// from immutable data, inside the host's own edit transaction. No plugin code.

export { commitArms, NEXT_KEY_MAX_DELTAS, NEXT_KEY_MAX_UNITS, replayNextKey } from './commit.ts';
export {
  cloneState,
  type DeferredEdit,
  emptyState,
  type Proposal,
  planWalk,
  replaceAnswer,
  type WalkResult,
  type WalkState,
} from './interpreter.ts';
export {
  ENGLISH_POLICY,
  exactLookupPolicy,
  policyByName,
  registerPolicy,
  type WordPolicy,
  type WordPolicyQuery,
  type WordProposal,
} from './policy.ts';
export {
  DEFAULT_INLINE_MAX_BYTES,
  InlineRegistrationError,
  lookupWord,
  MAX_INSERT_BYTES,
  MAX_SHORTCUTS,
  MAX_TABLE_BYTES,
  MAX_TABLE_ENTRIES,
  MAX_TRIGGER_POINTS,
  openTable,
  POLICY_BOUNDARIES,
  REQUIRED_SKIP,
  type RegisterContext,
  type RegisteredInline,
  receiptForTable,
  registerRuleSet,
  type Sha256,
  type TableReceipt,
} from './registry.ts';
export { createInlineRewriter, type InlineRewriter, type ShortcutCounts } from './rewriter.ts';
export { createInlineStage, type DeferredRequest, type InlineStage } from './stage.ts';
export { cursorAfterUndo, rebaseDeferred, rebasePatches, type UndoPatch } from './undo.ts';

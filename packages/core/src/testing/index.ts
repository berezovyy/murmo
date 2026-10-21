// @murmo/core/testing: what phases 05–10 test the core with before any real
// host or executor exists. Test code only; never part of a host bundle.

export { CancelledError, createManualClock, MANUAL_EPOCH_MS, type ManualClock } from './clock.ts';
export {
  changeView,
  createDirectRunner,
  type DirectPluginSpec,
  type DirectRunner,
  type DirectRunnerOptions,
  draftView,
} from './direct-runner.ts';
export { canonicalKey, createHarness, Driver, type Harness, type HarnessOptions } from './harness.ts';
export {
  type AuditEntry,
  type CapsPatch,
  type CommitFault,
  type CommittedEdit,
  patchCaps,
  ReferenceAdapter,
  type ReferenceAdapterOptions,
  referenceCaps,
  type SentRequest,
} from './reference-adapter.ts';

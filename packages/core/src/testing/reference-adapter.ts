// The reference adapter lives in `@murmo/fake-host` (phase 11). Core tests keep
// the old names so phases 05–10 stay constructor-compatible.

export {
  type AuditEntry,
  type CapsPatch,
  type CommitFault,
  type CommitTiming,
  type CommittedEdit,
  FakeAdapter as ReferenceAdapter,
  type FakeAdapterOptions as ReferenceAdapterOptions,
  patchCaps,
  type RestoreEntry,
  referenceCaps,
  type SentRequest,
} from '@murmo/fake-host';

// @murmo/fake-host: published fake host with measured profiles and a public
// test driver (docs/plan/11). The fully capable FakeAdapter is constructor-
// compatible with phase 05's reference adapter; profiles narrow it.

export {
  type AuditEntry,
  type CapsPatch,
  type CommitFault,
  type CommitTiming,
  type CommittedEdit,
  FakeAdapter,
  type FakeAdapterOptions,
  type PacketPart,
  patchCaps,
  type RestoreEntry,
  referenceCaps,
  type SentRequest,
} from './adapter.ts';
export { createFakeDriver, type FakeDriver, type FakeDriverObserve } from './driver.ts';
export {
  capsFromRecord,
  FakeEditorSlot,
  makeAdapter,
  ProfiledFakeAdapter,
  type ProfiledFakeAdapterOptions,
  profileEvidence,
} from './profiles.ts';
export {
  type CapabilityRecord,
  type FakeHostProfile,
  type HostQuirk,
  historicalFloor,
  newestRecord,
  profileIsStale,
  recordsFor,
  SEED_RECORDS,
} from './records.ts';

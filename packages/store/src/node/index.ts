// @murmo/store/node: the store on Node and Bun (Pi, OpenCode, the CLI, tests).
export type { CommandContext } from './commands.ts';
export { DATA_USAGE, dataCommand, PRIVATE_USAGE, privateCommand } from './commands.ts';
export type { DataKind, DeleteReport, DeleteSelector, InventoryKind, InventoryRow } from './data.ts';
export { DATA_KINDS } from './data.ts';
export type {
  ActivationOutcome,
  DistributionLedger,
  InstalledPlugin,
  JournalOp,
  JournalPhase,
  LastRollback,
  PluginDistribution,
  PluginSource,
  PluginsManifest,
  ProjectApproval,
  ProjectPluginRequest,
  PublisherIdentity,
  RevocationRecord,
  SessionAck,
  UpdateJournal,
} from './distribution.ts';
export {
  BUILTIN_IDS,
  bumpManifest,
  chainPrevious,
  clearJournal,
  DEFAULT_PLUGIN_ORDER,
  DISTRIBUTION_SCHEMA,
  defaultManifest,
  EMPTY_LEDGER,
  EMPTY_MANIFEST,
  GENERATIONS_KEPT,
  initPluginStore,
  JOURNAL_SCHEMA,
  listLiveSessions,
  PLUGINS_SCHEMA,
  QUIESCE_MS,
  readJournal,
  readLastRollback,
  readLedger,
  readPluginsManifest,
  recoverInterrupted,
  referencedDigests,
  removeGenerationFiles,
  removePluginTrees,
  SESSION_SCHEMA,
  waitForRevision,
  writeJournal,
  writeLastRollback,
  writeLedger,
  writePluginsManifest,
  writeSessionAck,
} from './distribution.ts';
export type { FileDraftsOptions } from './drafts.ts';
export { createFileDrafts } from './drafts.ts';
export type { ModeRepairs, WriteOptions } from './files.ts';
export {
  DIR_MODE,
  ensurePrivateDir,
  FILE_MODE,
  readStoreFile,
  removeStaleTemps,
  STALE_TEMP_MS,
  writeAtomic,
} from './files.ts';
export type { HeldLock, Locked, LockOptions } from './lock.ts';
export { LOCK_RETRY_MS, LOCK_STALE_MS, LOCK_TIMEOUT_MS, lockPath, withLock } from './lock.ts';
export type { LogEntry, LogRead } from './logs.ts';
export { compactLog, parseSegment, SEGMENT_BYTES } from './logs.ts';
export type { ProjectIdentity } from './paths.ts';
export { findRepositoryRoot, projectIdentity, projectIdOf, projectIdOfCwd, storeRootsFromEnv } from './paths.ts';
export type { PluginStorageBroker } from './plugin-storage.ts';
export type { Privacy } from './privacy.ts';
export type { RecordRead, RecordUpdate, UpdateOptions, UpdateResult } from './record.ts';
export { readRecord, updateRecord } from './record.ts';
export { handleStoreRequest } from './server.ts';
export type { SetRead, SnapshotPlace, SnapshotRead, SnapshotSetPlace, SwapResult } from './snapshots.ts';
export { readPointer, readSnapshot, readSnapshotSet, swapSnapshotSet, writeSnapshot } from './snapshots.ts';
export type {
  Generation,
  GenerationWatch,
  LogStore,
  SessionLog,
  Store,
  StoreOptions,
  TrustStore,
  WordStore,
  WriteResult,
} from './store.ts';
export { DENIED_PRIVATE, openStore } from './store.ts';

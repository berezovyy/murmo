// @murmo/store: every byte Murmo keeps on disk. This portable part holds the
// formats, the layout, the plugin storage rules and the Claude client; the
// Node and Bun backend is `@murmo/store/node`, the Rust one is rust/.

export type {
  DraftDecode,
  DraftDocument,
  DraftHeader,
  DraftIdentity,
  DraftSaveResult,
  Drafts,
  DraftWrite,
  HeldDraftLock,
} from './draft.ts';
export {
  checkDraftIdentity,
  DRAFT_MAX_HEADER_BYTES,
  DRAFT_MAX_TEXT_BYTES,
  DRAFT_TTL_MS,
  decodeDraft,
  draftExpired,
  draftHeader,
  draftIsOfferable,
  encodeDraft,
  newDraftSession,
} from './draft.ts';
export { sha256Hex, utf8Decode, utf8Encode, utf8Length } from './encoding.ts';
export type { DraftHost, LogKind, StoreLayout, StoreRoots } from './layout.ts';
export {
  checkDraftHost,
  checkProjectId,
  checkSessionId,
  DRAFT_HOSTS,
  distributionLedgerPath,
  draftFile,
  draftLockFile,
  extensionsDir,
  historyDirectory,
  historyMetricsPath,
  LOG_KINDS,
  lastRollbackPath,
  logDirectory,
  phraseDirectory,
  phraseMetricsPath,
  phraseSnapshotPath,
  pluginCacheFile,
  pluginGenerationStorage,
  pluginRecordPath,
  pluginSessionFile,
  pluginSessionsDir,
  pluginsManifestPath,
  projectCache,
  projectDirectory,
  projectDrafts,
  projectWordsPath,
  registryIndexPath,
  registryMetaPath,
  STORE_VERSION,
  storeLayout,
  updateJournalPath,
} from './layout.ts';

export type { MemoryDraftsOptions } from './memory-drafts.ts';
export { createMemoryDrafts } from './memory-drafts.ts';
export type { NamespaceChange, NamespaceData } from './plugin-namespace.ts';
export {
  jsonCopy,
  PRIVATE_MODE_REASON,
  quotaProblem,
  storageDelete,
  storageGet,
  storageKeyProblem,
  storageSet,
} from './plugin-namespace.ts';
export type { StoreReply, StoreRequest } from './protocol.ts';
export { parseStoreRequest } from './protocol.ts';
export type {
  MetaRecord,
  PluginRecord,
  PrivateFlag,
  RecordKind,
  RecordTypes,
  SnapshotPointer,
  TrustApproval,
  TrustRecord,
  WordsRecord,
} from './records.ts';
export { decodeRecord, EMPTY_TRUST, EMPTY_WORDS, encodeRecord, RECORD_MAX_BYTES, RECORD_SCHEMA } from './records.ts';
export type { RemoteStore, RemoteWrite, StoreTransport } from './remote.ts';
export { createRemoteStore } from './remote.ts';
export type { ReadRange, Snapshot, SnapshotDecode, SnapshotFields, SnapshotHeader } from './snapshot.ts';
export { CHUNK_BYTES, decodeSnapshot, encodeSnapshot, readSnapshotChunked } from './snapshot.ts';

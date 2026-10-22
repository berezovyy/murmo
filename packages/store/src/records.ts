// Record formats. A record is one JSON document `{"schema":1,…}`, at most
// 1 MiB so one Claude `$.fs` call (4 MiB) reads it whole; plugin namespaces are
// smaller still (LIMITS.storageBytes). Every reader checks the shape, so a
// hand-edited or foreign file is treated as unreadable, never trusted.

export const RECORD_SCHEMA = 1;
export const RECORD_MAX_BYTES = 1_048_576;

/** The record `murmo trust` stores per approved project (r8 § 54). */
export interface TrustApproval {
  /** sha256(realpath(root)), hex. */
  readonly projectId: string;
  /** Canonical root, for display only. */
  readonly root: string;
  /** Device and inode of the root as decimal strings (64-bit values). */
  readonly dev: string;
  readonly ino: string;
  /** SHA-256 of the canonical trust manifest (@murmo/config `trustManifest`). */
  readonly fingerprint: string;
  /** Wall-clock milliseconds. */
  readonly approvedAt: number;
  readonly shortcutCount: number;
  /**
   * SHA-256 of each shortcut's expansion text (phase 15). A later `murmo trust`
   * can name added/removed/changed shortcuts without storing the text. Absent
   * on approvals written before phase 15.
   */
  readonly hashes?: Readonly<Record<string, string>>;
}

export interface TrustRecord {
  readonly schema: 1;
  readonly approvals: Readonly<Record<string, TrustApproval>>;
}

export interface WordsRecord {
  readonly schema: 1;
  readonly words: readonly string[];
}

export interface PluginRecord {
  readonly schema: 1;
  /** The plugin ID, kept so `murmo data show` can name the namespace. */
  readonly plugin: string;
  readonly data: Readonly<Record<string, unknown>>;
  /** Per-key compare-and-set revisions (phase 32). Absent on records written before 32. */
  readonly revisions?: Readonly<Record<string, number>>;
}

/**
 * Sessions compare `(epoch, generation)` on each idle check: a change means
 * something was deleted and in-memory copies must be dropped. The epoch is new
 * whenever meta.json is recreated, so `delete --all` can't reset the counter
 * to a value a session has already seen.
 */
export interface MetaRecord {
  readonly schema: 1;
  readonly epoch: string;
  readonly generation: number;
}

export interface PrivateFlag {
  readonly schema: 1;
  /** Wall-clock milliseconds when private mode was turned on. */
  readonly since: number;
}

/** `current` of a multi-file snapshot set: which generation's directory is whole. */
export interface SnapshotPointer {
  readonly schema: 1;
  readonly generation: number;
  /** Directory name, `snap-<generation>`. */
  readonly directory: string;
  /** The set this one replaced, kept until the next swap so open readers finish. */
  readonly previous?: string;
  readonly files: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>;
}

export type RecordKind = 'trust' | 'words' | 'plugin' | 'meta' | 'private' | 'pointer';

export interface RecordTypes {
  trust: TrustRecord;
  words: WordsRecord;
  plugin: PluginRecord;
  meta: MetaRecord;
  private: PrivateFlag;
  pointer: SnapshotPointer;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isHashes(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObject(value)) return false;
  return Object.entries(value).every(([key, hash]) => key.length > 0 && typeof hash === 'string' && HEX64.test(hash));
}

function isApproval(id: string, value: unknown): value is TrustApproval {
  return (
    isObject(value) &&
    value.projectId === id &&
    HEX64.test(id) &&
    typeof value.root === 'string' &&
    typeof value.dev === 'string' &&
    DECIMAL.test(value.dev) &&
    typeof value.ino === 'string' &&
    DECIMAL.test(value.ino) &&
    typeof value.fingerprint === 'string' &&
    HEX64.test(value.fingerprint) &&
    isCount(value.approvedAt) &&
    isCount(value.shortcutCount) &&
    isHashes(value.hashes)
  );
}

const CHECKS: { readonly [K in RecordKind]: (value: Record<string, unknown>) => boolean } = {
  trust: (v) => isObject(v.approvals) && Object.entries(v.approvals).every(([id, a]) => isApproval(id, a)),
  words: (v) => Array.isArray(v.words) && v.words.every((w) => typeof w === 'string'),
  plugin: (v) => typeof v.plugin === 'string' && isObject(v.data),
  meta: (v) => typeof v.epoch === 'string' && /^[0-9a-f]{32}$/.test(v.epoch) && isCount(v.generation),
  private: (v) => isCount(v.since),
  pointer: (v) =>
    isCount(v.generation) &&
    v.directory === `snap-${v.generation}` &&
    (v.previous === undefined || (typeof v.previous === 'string' && /^snap-[0-9]+$/.test(v.previous))) &&
    isObject(v.files) &&
    Object.entries(v.files).every(
      ([name, f]) =>
        /^[A-Za-z0-9._-]{1,64}$/.test(name) &&
        !name.startsWith('.') &&
        isObject(f) &&
        isCount(f.bytes) &&
        typeof f.sha256 === 'string' &&
        HEX64.test(f.sha256),
    ),
};

/** The record in `text`, or undefined when it isn't one of this kind and schema. */
export function decodeRecord<K extends RecordKind>(kind: K, text: string): RecordTypes[K] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value.schema !== RECORD_SCHEMA) return undefined;
  return CHECKS[kind](value) ? (value as unknown as RecordTypes[K]) : undefined;
}

/** Canonical bytes of a record: compact JSON with a trailing newline, as inspectable text. */
export function encodeRecord(record: RecordTypes[RecordKind]): string {
  return `${JSON.stringify(record)}\n`;
}

export const EMPTY_TRUST: TrustRecord = { schema: 1, approvals: {} };
export const EMPTY_WORDS: WordsRecord = { schema: 1, words: [] };

// The Node and Bun store: one object a session, the CLI or the helper opens.
// All calls are async and belong off the key path (idle ticks); a `busy`
// result is retried on the next idle tick.
import { randomBytes } from 'node:crypto';
import {
  checkProjectId,
  type LogKind,
  logDirectory,
  projectWordsPath,
  type StoreLayout,
  type StoreRoots,
  storeLayout,
} from '../layout.ts';
import { EMPTY_TRUST, EMPTY_WORDS, type MetaRecord, type TrustApproval, type TrustRecord } from '../records.ts';
import { type DeleteReport, type DeleteSelector, deleteData, type InventoryRow, inventory } from './data.ts';
import { exists, newRepairs, removeStaleTemps } from './files.ts';
import { createLogWriter, type LogEntry, type LogRead, readLog } from './logs.ts';
import { createPluginStorageBroker, type PluginStorageBroker } from './plugin-storage.ts';
import { createPrivacy, type Privacy } from './privacy.ts';
import { readRecord, updateRecord } from './record.ts';

export type WriteResult =
  | { readonly status: 'ok'; readonly written: boolean }
  | { readonly status: 'denied'; readonly reason: string }
  | { readonly status: 'busy' }
  | { readonly status: 'error'; readonly reason: string };

export const DENIED_PRIVATE = { status: 'denied', reason: 'private mode' } as const;

export interface StoreOptions {
  readonly roots: StoreRoots;
  /** `[privacy] private` of the merged config; the flag file counts too. */
  readonly configPrivate?: boolean;
}

export interface TrustStore {
  read(): Promise<TrustRecord>;
  find(projectId: string): Promise<TrustApproval | undefined>;
  /** Saved durably, private mode or not: approval is an explicit user action. */
  approve(approval: TrustApproval): Promise<WriteResult>;
  revoke(projectId: string): Promise<WriteResult>;
}

export interface WordStore {
  /** The global allowlist, or one project's. */
  list(projectId?: string): Promise<string[]>;
  /** `learned`: the word comes from Backspace learning (phase 19), refused in private mode. */
  add(word: string, options: { readonly learned: boolean; readonly projectId?: string }): Promise<WriteResult>;
  remove(word: string, options?: { readonly projectId?: string }): Promise<WriteResult>;
}

export interface SessionLog {
  append(entries: readonly LogEntry[]): Promise<WriteResult>;
}

export interface LogStore {
  session(kind: LogKind, sessionId: string): SessionLog;
  read(kind: LogKind): Promise<LogRead>;
}

export interface Generation {
  readonly epoch: string;
  readonly generation: number;
}

export interface GenerationWatch {
  /**
   * True when a delete happened since the last call (the first call only
   * records where things stand). Sessions call it on each idle check and drop
   * the in-memory data the delete covered.
   */
  changed(): Promise<boolean>;
}

export interface Store {
  readonly layout: StoreLayout;
  readonly privacy: Privacy;
  readonly trust: TrustStore;
  readonly words: WordStore;
  readonly plugins: PluginStorageBroker;
  readonly logs: LogStore;
  generation(): Promise<Generation>;
  watchGeneration(): GenerationWatch;
  inventory(projectId?: string): Promise<InventoryRow[]>;
  /** Deletes, then bumps the generation. */
  delete(selector: DeleteSelector): Promise<DeleteReport & { readonly generation: Generation }>;
  /** Paths whose wider mode was repaired since the last call; report each once. */
  takeRepairs(): string[];
}

/**
 * Explicit sets, so the Rust store (rust/src/protocol.rs) refuses the same
 * words: JavaScript's `\s` plus U+0085, and C0/C1 controls, bidi overrides and
 * isolates, zero-width characters and unpaired surrogates.
 */
const WHITESPACE =
  /[\t\n\v\f\r \u0085\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]/u;
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}]|[\ud800-\udfff]/u;

/** A word the allowlist can hold: one token of at most 64 code points, nothing invisible. */
export function wordProblem(word: string): string | null {
  if (typeof word !== 'string' || word.length === 0) return 'a word is a non-empty string';
  if ([...word].length > 64) return 'a word is at most 64 characters';
  if (WHITESPACE.test(word)) return 'a word has no whitespace';
  if (INVISIBLE.test(word)) return 'a word has no control or invisible characters';
  return null;
}

function toWrite(outcome: Awaited<ReturnType<typeof updateRecord>>): WriteResult {
  if (outcome.status === 'ok') return { status: 'ok', written: outcome.written };
  return outcome;
}

/**
 * Opens the store. Nothing is created until something is written; stale temps
 * left by killed writers are removed from the folders that exist.
 */
export async function openStore(options: StoreOptions): Promise<Store> {
  const layout = storeLayout(options.roots);
  const repairs = newRepairs();
  const privacy = createPrivacy(layout, options.configPrivate ?? false, repairs);
  const base = layout.roots.data;

  for (const dir of [layout.store, layout.plugins, logDirectory(layout, 'phrases'), logDirectory(layout, 'history')]) {
    await removeStaleTemps(dir);
  }

  const trust: TrustStore = {
    async read() {
      const read = await readRecord('trust', layout.trust, repairs);
      return read.status === 'ok' ? read.record : EMPTY_TRUST;
    },
    async find(projectId) {
      const record = await trust.read();
      return Object.hasOwn(record.approvals, projectId) ? record.approvals[projectId] : undefined;
    },
    async approve(approval) {
      checkProjectId(approval.projectId);
      return toWrite(
        await updateRecord(
          'trust',
          layout.trust,
          (current) => {
            const approvals = { ...(current ?? EMPTY_TRUST).approvals };
            Object.defineProperty(approvals, approval.projectId, {
              value: approval,
              enumerable: true,
              configurable: true,
              writable: true,
            });
            return { record: { schema: 1, approvals }, result: undefined };
          },
          { base, durable: true, repairs },
        ),
      );
    },
    async revoke(projectId) {
      return toWrite(
        await updateRecord(
          'trust',
          layout.trust,
          (current) => {
            if (!current || !Object.hasOwn(current.approvals, projectId)) return { unchanged: undefined };
            const approvals = { ...current.approvals };
            delete approvals[projectId];
            return { record: { schema: 1, approvals }, result: undefined };
          },
          { base, durable: true, repairs },
        ),
      );
    },
  };

  const wordsPath = (projectId?: string) =>
    projectId === undefined ? layout.words : projectWordsPath(layout, checkProjectId(projectId));

  const words: WordStore = {
    async list(projectId) {
      const read = await readRecord('words', wordsPath(projectId), repairs);
      return read.status === 'ok' ? [...read.record.words] : [];
    },
    async add(word, { learned, projectId }) {
      const problem = wordProblem(word);
      if (problem) return { status: 'denied', reason: problem };
      if (learned && (await privacy.isPrivate())) return DENIED_PRIVATE;
      return toWrite(
        await updateRecord(
          'words',
          wordsPath(projectId),
          (current) => {
            const list = (current ?? EMPTY_WORDS).words;
            if (list.includes(word)) return { unchanged: undefined };
            return { record: { schema: 1, words: [...list, word] }, result: undefined };
          },
          { base, durable: true, repairs },
        ),
      );
    },
    async remove(word, { projectId } = {}) {
      const path = wordsPath(projectId);
      if (!(await exists(path))) return { status: 'ok', written: false };
      return toWrite(
        await updateRecord(
          'words',
          path,
          (current) => {
            const list = (current ?? EMPTY_WORDS).words;
            if (!list.includes(word)) return { unchanged: undefined };
            return { record: { schema: 1, words: list.filter((w) => w !== word) }, result: undefined };
          },
          { base, durable: true, repairs },
        ),
      );
    },
  };

  const logs: LogStore = {
    session(kind, sessionId) {
      const writer = createLogWriter(layout, kind, sessionId, repairs);
      return {
        async append(entries) {
          if (await privacy.isPrivate()) return DENIED_PRIVATE;
          const lines = entries.map((entry) => JSON.stringify(entry));
          try {
            await writer.appendLines(lines);
          } catch (error) {
            return { status: 'error', reason: (error as Error).message };
          }
          return { status: 'ok', written: lines.length > 0 };
        },
      };
    },
    read: (kind) => readLog(layout, kind),
  };

  async function generation(): Promise<Generation> {
    const read = await readRecord('meta', layout.meta, repairs);
    return read.status === 'ok'
      ? { epoch: read.record.epoch, generation: read.record.generation }
      : { epoch: 'none', generation: 0 };
  }

  async function bump(): Promise<Generation> {
    const outcome = await updateRecord(
      'meta',
      layout.meta,
      (current) => {
        const next: MetaRecord = {
          schema: 1,
          epoch: current?.epoch ?? randomBytes(16).toString('hex'),
          generation: (current?.generation ?? 0) + 1,
        };
        return { record: next, result: next };
      },
      { base, durable: true, repairs },
    );
    if (outcome.status !== 'ok') throw new Error(outcome.status === 'busy' ? 'meta.json is busy' : outcome.reason);
    return { epoch: outcome.result.epoch, generation: outcome.result.generation };
  }

  return {
    layout,
    privacy,
    trust,
    words,
    plugins: createPluginStorageBroker(layout, privacy, repairs),
    logs,
    generation,
    watchGeneration() {
      let seen: string | undefined;
      return {
        async changed() {
          const now = await generation();
          const id = `${now.epoch}:${now.generation}`;
          const changed = seen !== undefined && seen !== id;
          seen = id;
          return changed;
        },
      };
    },
    inventory: (projectId) => inventory(layout, projectId === undefined ? undefined : checkProjectId(projectId)),
    async delete(selector) {
      if ('projectId' in selector) checkProjectId(selector.projectId);
      const report = await deleteData(layout, selector, repairs);
      return { ...report, generation: await bump() };
    },
    takeRepairs() {
      return repairs.repaired.splice(0);
    },
  };
}

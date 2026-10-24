// Plugin distribution state on disk: plugins.json, the trust ledger, the
// update journal, generation snapshots and live-session acknowledgements.
// All writes are temp-then-rename. The journal lets the next command finish
// or undo an interrupted multi-file update (round 14 did not prove this).

import { rm } from 'node:fs/promises';
import {
  distributionLedgerPath,
  extensionsDir,
  lastRollbackPath,
  pluginCacheFile,
  pluginGenerationStorage,
  pluginSessionFile,
  pluginSessionsDir,
  pluginsManifestPath,
  type StoreRoots,
  updateJournalPath,
} from '../layout.ts';
import {
  BUILTIN_IDS,
  type InstalledPlugin,
  type PluginSelection,
  type PluginsManifest,
  parsePluginsManifest,
  readPluginSelection,
} from '../plugins.ts';
import { DIR_MODE, ensurePrivateDir, FILE_MODE, processAlive, readStoreFile, writeAtomic } from './files.ts';

export {
  BUILTIN_IDS,
  type InstalledPlugin,
  PLUGINS_SCHEMA,
  type PluginDistribution,
  type PluginSource,
  type PluginsManifest,
} from '../plugins.ts';

export const DISTRIBUTION_SCHEMA = 1;
export const JOURNAL_SCHEMA = 1;
export const SESSION_SCHEMA = 1;
export const GENERATIONS_KEPT = 2;
export const QUIESCE_MS = 4000;
export const MANIFEST_MAX_BYTES = 1_048_576;

export type ActivationOutcome = 'loaded' | 'activated' | 'disabled' | 'error';
export type JournalPhase = 'extract' | 'quiesce' | 'snapshot' | 'preflight' | 'select';
export type JournalOp = 'add' | 'update';

export interface PublisherIdentity {
  readonly publisher: string;
  readonly highWater: number;
  readonly highestVersion: string;
  readonly versions: Readonly<Record<string, string>>;
  /** Fingerprints from oldest to current after rotations. High-water never lowers. */
  readonly chain?: readonly string[];
}

/** A key or version marked bad. Registry listings feed this; the check is phase 32. */
export interface RevocationRecord {
  readonly publisher: string;
  readonly plugin?: string;
  readonly version?: string;
  readonly reason: string;
  readonly issuedAt: number;
  readonly signature: string;
}

export interface ProjectApproval {
  readonly digest: string;
  readonly requests: readonly ProjectPluginRequest[];
}

export interface ProjectPluginRequest {
  readonly id: string;
  readonly source: string;
  readonly digest: string;
  readonly publisher: string;
}

export interface DistributionLedger {
  readonly schema: typeof DISTRIBUTION_SCHEMA;
  readonly identities: Readonly<Record<string, PublisherIdentity>>;
  readonly projects: Readonly<Record<string, ProjectApproval>>;
  readonly revocations?: readonly RevocationRecord[];
  /** Fingerprint of the local development key, recorded when a folder plugin is first approved. */
  readonly localPublisher?: string;
}

export interface UpdateJournal {
  readonly schema: typeof JOURNAL_SCHEMA;
  readonly op: JournalOp;
  readonly id: string;
  readonly phase: JournalPhase;
  readonly toDigest: string;
  readonly fromDigest?: string;
  readonly previousEnabled?: boolean;
}

export interface LastRollback {
  readonly id: string;
  readonly failedDigest: string;
  readonly to: string;
  readonly error: string;
  readonly phase?: string;
  readonly at: number;
}

export interface SessionAck {
  readonly schema: typeof SESSION_SCHEMA;
  readonly pid: number;
  readonly host: string;
  readonly revision: number;
  readonly plugins: Readonly<Record<string, ActivationOutcome>>;
  readonly errors?: Readonly<Record<string, string>>;
}

export const EMPTY_MANIFEST: PluginsManifest = { schema: 1, revision: 0, order: [], plugins: {} };
export const EMPTY_LEDGER: DistributionLedger = { schema: 1, identities: {}, projects: {} };

export const DEFAULT_PLUGIN_ORDER: readonly string[] = BUILTIN_IDS;

export function defaultManifest(): PluginsManifest {
  const plugins: Record<string, InstalledPlugin> = {};
  for (const id of BUILTIN_IDS) plugins[id] = { enabled: true, builtin: true, grants: [] };
  return { schema: 1, revision: 0, order: [...DEFAULT_PLUGIN_ORDER], plugins };
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const read = await readStoreFile(path, MANIFEST_MAX_BYTES);
  if (read.status !== 'ok') return undefined;
  try {
    return JSON.parse(Buffer.from(read.bytes).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(roots: StoreRoots, path: string, value: unknown): Promise<void> {
  await ensurePrivateDir(path.slice(0, path.lastIndexOf('/')), roots.data);
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readPluginsManifest(roots: StoreRoots): Promise<PluginsManifest | undefined> {
  const read = await readStoreFile(pluginsManifestPath(roots), MANIFEST_MAX_BYTES);
  return read.status === 'ok' ? parsePluginsManifest(read.bytes) : undefined;
}

/** Largest plugin file a session reads (the archive rules cap the entry at 1 MiB). */
const PLUGIN_FILE_MAX_BYTES = 1_048_576;

/** The plugins a new Node or Bun session loads (Pi, OpenCode); Claude reads the same files through its host. */
export function readInstalledPlugins(roots: StoreRoots): Promise<PluginSelection> {
  return readPluginSelection(roots, async (path) => {
    const read = await readStoreFile(path, PLUGIN_FILE_MAX_BYTES);
    if (read.status === 'ok') return read.bytes;
    if (read.status === 'missing') return undefined;
    throw new Error(`${path} ${read.reason}`);
  });
}

export async function writePluginsManifest(roots: StoreRoots, manifest: PluginsManifest): Promise<void> {
  await writeJson(roots, pluginsManifestPath(roots), manifest);
}

export async function bumpManifest(roots: StoreRoots, manifest: PluginsManifest): Promise<PluginsManifest> {
  const next = { ...manifest, revision: manifest.revision + 1 };
  await writePluginsManifest(roots, next);
  return next;
}

export async function readLedger(roots: StoreRoots): Promise<DistributionLedger> {
  return (await readJson<DistributionLedger>(distributionLedgerPath(roots))) ?? EMPTY_LEDGER;
}

export async function writeLedger(roots: StoreRoots, ledger: DistributionLedger): Promise<void> {
  await writeJson(roots, distributionLedgerPath(roots), ledger);
}

export async function readJournal(roots: StoreRoots): Promise<UpdateJournal | undefined> {
  const value = await readJson<UpdateJournal>(updateJournalPath(roots));
  if (value?.schema !== 1) return undefined;
  return value;
}

export async function writeJournal(roots: StoreRoots, journal: UpdateJournal): Promise<void> {
  await writeJson(roots, updateJournalPath(roots), journal);
}

export async function clearJournal(roots: StoreRoots): Promise<void> {
  await rm(updateJournalPath(roots), { force: true });
}

export async function writeLastRollback(roots: StoreRoots, record: LastRollback): Promise<void> {
  await writeJson(roots, lastRollbackPath(roots), record);
}

export async function readLastRollback(roots: StoreRoots): Promise<LastRollback | undefined> {
  return readJson<LastRollback>(lastRollbackPath(roots));
}

export async function writeSessionAck(roots: StoreRoots, sessionId: string, ack: SessionAck): Promise<void> {
  await ensurePrivateDir(pluginSessionsDir(roots), roots.data);
  await writeAtomic(pluginSessionFile(roots, sessionId), `${JSON.stringify(ack)}\n`);
}

export async function listLiveSessions(roots: StoreRoots): Promise<readonly { id: string; ack: SessionAck }[]> {
  const { readdir } = await import('node:fs/promises');
  let names: string[];
  try {
    names = await readdir(pluginSessionsDir(roots));
  } catch {
    return [];
  }
  const live: { id: string; ack: SessionAck }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const ack = await readJson<SessionAck>(pluginSessionFile(roots, id));
    if (ack?.schema !== 1 || !Number.isSafeInteger(ack.pid)) continue;
    if (!processAlive(ack.pid)) continue;
    live.push({ id, ack });
  }
  return live;
}

export async function waitForRevision(
  roots: StoreRoots,
  revision: number,
  timeoutMs = QUIESCE_MS,
  now = () => Date.now(),
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const start = now();
  for (;;) {
    const pending = (await listLiveSessions(roots)).filter((s) => s.ack.revision !== revision);
    if (pending.length === 0) return;
    if (now() - start >= timeoutMs) {
      throw new Error(JSON.stringify({ code: 'session-quiescence-timeout', pending: pending.map((s) => s.id) }));
    }
    await pause(30);
  }
}

export function chainPrevious(old: InstalledPlugin | undefined, keep = GENERATIONS_KEPT): InstalledPlugin | undefined {
  if (!old) return undefined;
  if (!old.previous) return old;
  if (keep <= 1) {
    const { previous: _dropped, ...rest } = old;
    return rest;
  }
  const previous = chainPrevious(old.previous, keep - 1);
  return previous ? { ...old, previous } : { ...old, previous: old.previous };
}

export function referencedDigests(plugin: InstalledPlugin | undefined): Set<string> {
  const out = new Set<string>();
  let current: InstalledPlugin | undefined = plugin;
  while (current) {
    if (current.distribution) out.add(current.distribution.digest);
    current = current.previous;
  }
  return out;
}

export async function removeGenerationFiles(roots: StoreRoots, pluginId: string, digest: string): Promise<void> {
  await rm(extensionsDir(roots, pluginId, digest), { recursive: true, force: true });
  await rm(pluginCacheFile(roots, pluginId, digest), { force: true });
  await rm(pluginGenerationStorage(roots, pluginId, digest), { force: true });
}

export async function removePluginTrees(roots: StoreRoots, pluginId: string): Promise<void> {
  await rm(`${roots.data}/extensions/${pluginId}`, { recursive: true, force: true });
  await rm(`${roots.data}/plugin-cache/${pluginId}`, { recursive: true, force: true });
  await rm(`${roots.data}/plugin-storage/${pluginId}`, { recursive: true, force: true });
}

/**
 * Finish or undo an interrupted add/update. `plugins.json` is the commit
 * point: a matching `toDigest` means the new generation is selected.
 */
export async function recoverInterrupted(roots: StoreRoots): Promise<'committed' | 'undone' | 'clean'> {
  const journal = await readJournal(roots);
  if (!journal) return 'clean';
  const manifest = (await readPluginsManifest(roots)) ?? EMPTY_MANIFEST;
  const selected = manifest.plugins[journal.id];
  if (selected?.distribution?.digest === journal.toDigest) {
    await clearJournal(roots);
    return 'committed';
  }
  if (
    selected &&
    journal.fromDigest &&
    selected.distribution?.digest === journal.fromDigest &&
    journal.previousEnabled !== undefined
  ) {
    const restored: PluginsManifest = {
      ...manifest,
      revision: manifest.revision + 1,
      plugins: {
        ...manifest.plugins,
        [journal.id]: { ...selected, enabled: journal.previousEnabled },
      },
    };
    await writePluginsManifest(roots, restored);
  }
  await removeGenerationFiles(roots, journal.id, journal.toDigest);
  await clearJournal(roots);
  return 'undone';
}

export async function initPluginStore(roots: StoreRoots): Promise<PluginsManifest> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(roots.data, { recursive: true, mode: DIR_MODE });
  const existing = await readPluginsManifest(roots);
  if (existing) return existing;
  const manifest = defaultManifest();
  await writePluginsManifest(roots, manifest);
  await writeLedger(roots, EMPTY_LEDGER);
  return manifest;
}

export { FILE_MODE };

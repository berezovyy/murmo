// Where Murmo keeps every byte it writes. Three roots, all Murmo's own
// (never under a host's config directory, knowledge § 7): data that must
// survive, state that may be lost, and caches that can be rebuilt. Uninstall
// (phase 27) removes the three roots. macOS and Linux only, so paths use `/`.
import { sha256Hex, utf8Encode } from './encoding.ts';

export interface StoreRoots {
  /** `$XDG_DATA_HOME/murmo` (default `~/.local/share/murmo`). */
  readonly data: string;
  /** `$XDG_STATE_HOME/murmo` (default `~/.local/state/murmo`). */
  readonly state: string;
  /** `$XDG_CACHE_HOME/murmo` (default `~/.cache/murmo`). */
  readonly cache: string;
}

export const STORE_VERSION = 'v1';

export interface StoreLayout {
  readonly roots: StoreRoots;
  /** `<data>/store/v1`: every record and log. */
  readonly store: string;
  /** Schema and the generation counter sessions watch for deletes. */
  readonly meta: string;
  /** Project approvals. */
  readonly trust: string;
  /** The user's global allowlist. */
  readonly words: string;
  readonly plugins: string;
  readonly projects: string;
  readonly logs: string;
  /** `$XDG_STATE_HOME/murmo/drafts/v1` (phase 17 writes inside it). */
  readonly drafts: string;
  /** Present while private mode is on (`murmo private on`). */
  readonly privateFlag: string;
}

export function storeLayout(roots: StoreRoots): StoreLayout {
  const store = `${roots.data}/store/${STORE_VERSION}`;
  return {
    roots,
    store,
    meta: `${store}/meta.json`,
    trust: `${store}/trust.json`,
    words: `${store}/words.json`,
    plugins: `${store}/plugins`,
    projects: `${store}/projects`,
    logs: `${store}/logs`,
    drafts: `${roots.state}/drafts/${STORE_VERSION}`,
    privateFlag: `${roots.state}/private`,
  };
}

/** Selected generation, revision, grants and order (`<data>/plugins.json`). */
export function pluginsManifestPath(roots: StoreRoots): string {
  return `${roots.data}/plugins.json`;
}

/** Publisher pins, high-water and project approvals. Survives `plugin remove`. */
export function distributionLedgerPath(roots: StoreRoots): string {
  return `${roots.data}/distribution.json`;
}

/** Interrupted add/update journal; finished or undone on the next command. */
export function updateJournalPath(roots: StoreRoots): string {
  return `${roots.data}/update.json`;
}

export function lastRollbackPath(roots: StoreRoots): string {
  return `${roots.data}/last-rollback.json`;
}

export function extensionsDir(roots: StoreRoots, pluginId: string, digest: string): string {
  return `${roots.data}/extensions/${pluginId}/${digest}`;
}

export function pluginCacheFile(roots: StoreRoots, pluginId: string, digest: string): string {
  return `${roots.data}/plugin-cache/${pluginId}/${digest}.tgz`;
}

export function pluginGenerationStorage(roots: StoreRoots, pluginId: string, digest: string): string {
  return `${roots.data}/plugin-storage/${pluginId}/${digest}.json`;
}

export function pluginSessionsDir(roots: StoreRoots): string {
  return `${roots.data}/sessions`;
}

export function pluginSessionFile(roots: StoreRoots, sessionId: string): string {
  return `${pluginSessionsDir(roots)}/${checkSessionId(sessionId)}.json`;
}

/** A plugin's storage namespace file: its ID hashed, so any ID is a safe file name. */
export function pluginRecordPath(layout: StoreLayout, pluginId: string): string {
  return `${layout.plugins}/${sha256Hex(utf8Encode(pluginId))}.json`;
}

export function projectDirectory(layout: StoreLayout, projectId: string): string {
  return `${layout.projects}/${checkProjectId(projectId)}`;
}

export function projectWordsPath(layout: StoreLayout, projectId: string): string {
  return `${projectDirectory(layout, projectId)}/words.json`;
}

/** Rebuildable per-project indexes (phase 19); deleted with the project. */
export function projectCache(layout: StoreLayout, projectId: string): string {
  return `${layout.roots.cache}/${checkProjectId(projectId)}`;
}

/** Draft snapshots of one project (phase 17). */
export function projectDrafts(layout: StoreLayout, projectId: string): string {
  return `${layout.drafts}/${checkProjectId(projectId)}`;
}

/**
 * Hosts a draft file may name. The four agents plus `fake` (the reference
 * adapter in tests). Offers are same-host only (phase 17).
 */
export const DRAFT_HOSTS = ['claude', 'codex', 'opencode', 'pi', 'fake'] as const;
export type DraftHost = (typeof DRAFT_HOSTS)[number];

export function checkDraftHost(host: string): DraftHost {
  if (!(DRAFT_HOSTS as readonly string[]).includes(host)) throw new Error(`unknown draft host ${host}`);
  return host as DraftHost;
}

/** `$XDG_STATE_HOME/murmo/drafts/v1/<projectId>/<host>/<sessionId>.draft` */
export function draftFile(layout: StoreLayout, projectId: string, host: string, sessionId: string): string {
  return `${projectDrafts(layout, projectId)}/${checkDraftHost(host)}/${checkSessionId(sessionId)}.draft`;
}

/** Liveness lock next to the snapshot (`<sessionId>.lock`). */
export function draftLockFile(layout: StoreLayout, projectId: string, host: string, sessionId: string): string {
  return `${projectDrafts(layout, projectId)}/${checkDraftHost(host)}/${checkSessionId(sessionId)}.lock`;
}

/** Learned-event logs (phases 34, 35): one folder per kind. */
export const LOG_KINDS = ['phrases', 'history'] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export function logDirectory(layout: StoreLayout, kind: LogKind): string {
  if (!(LOG_KINDS as readonly string[]).includes(kind)) throw new Error(`unknown log kind ${String(kind)}`);
  return `${layout.logs}/${kind}`;
}

/** Packed phrase index (phase 34): global `<data>/store/v1/phrases/`. */
export function phraseDirectory(layout: StoreLayout, projectId?: string): string {
  return projectId === undefined ? `${layout.store}/phrases` : `${projectDirectory(layout, projectId)}/phrases`;
}

export function phraseSnapshotPath(layout: StoreLayout, projectId?: string): string {
  return `${phraseDirectory(layout, projectId)}/phrases.bin`;
}

export function phraseMetricsPath(layout: StoreLayout): string {
  return `${layout.store}/phrases/metrics.json`;
}

/** Packed history snapshot set (phase 35): `<data>/store/v1/history/` with `current`. */
export function historyDirectory(layout: StoreLayout): string {
  return `${layout.store}/history`;
}

export function historyMetricsPath(layout: StoreLayout): string {
  return `${layout.store}/history/metrics.json`;
}

const PROJECT_ID = /^[0-9a-f]{64}$/;

/** A project ID is a SHA-256 hex digest; anything else would let a caller escape the layout. */
export function checkProjectId(projectId: string): string {
  if (!PROJECT_ID.test(projectId)) throw new Error('project id must be 64 lowercase hex digits');
  return projectId;
}

/** Session IDs name log segments; the same rule keeps them file-name safe. */
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

export function checkSessionId(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error('session id must be 1-64 letters, digits or "-"');
  return sessionId;
}

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

/** Learned-event logs (phases 34, 35): one folder per kind. */
export const LOG_KINDS = ['phrases', 'history'] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export function logDirectory(layout: StoreLayout, kind: LogKind): string {
  if (!(LOG_KINDS as readonly string[]).includes(kind)) throw new Error(`unknown log kind ${String(kind)}`);
  return `${layout.logs}/${kind}`;
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

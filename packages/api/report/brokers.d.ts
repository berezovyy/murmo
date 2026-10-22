/**
 * Storage results. `denied` carries a reason, e.g. `private mode` (phase 14).
 * `quota`: the write would exceed `LIMITS.storageBytes`, `LIMITS.storageKeys` or
 * `LIMITS.storageKeyUnits`.
 */
export interface StorageResult {
    readonly status: 'ok' | 'quota' | 'denied' | 'error' | 'conflict';
    /** The stored JSON value for a successful `get`; absent when the key is unset. */
    readonly value?: unknown;
    /** Per-key revision; `0` when the key is unset. Compare-and-set uses this. */
    readonly revision?: number;
    readonly reason?: string;
}
/**
 * JSON-only storage, namespaced by the plugin's stable ID and bounded by
 * `LIMITS.storageBytes`. Operations in one namespace are serialized, but a
 * read-modify-write across two calls is not atomic. Closure state is not durable.
 */
export interface PluginStorage {
    get(key: string): Promise<StorageResult>;
    set(key: string, value: unknown): Promise<StorageResult>;
    delete(key: string): Promise<StorageResult>;
    /**
     * Compare-and-set: write `value` only when the stored revision is `expected`.
     * Pass `expected: 0` (or omit after a miss) to create. `conflict` if another
     * session wrote first (FEEDBACK M7).
     */
    cas(key: string, expected: number, value: unknown): Promise<StorageResult>;
}
export type ProjectReadStatus = 'ok' | 'denied' | 'approval-required' | 'too-large' | 'quota' | 'not-found' | 'invalid-utf8' | 'timeout' | 'cancelled';
export interface ProjectReadResult {
    readonly status: ProjectReadStatus;
    /** UTF-8 decoded text, present when `status` is `ok`. */
    readonly text?: string;
    readonly bytes?: number;
    readonly sha256?: string;
    /** The project-relative path that was read. */
    readonly path?: string;
    readonly reason?: string;
}
export type ProjectListStatus = 'ok' | 'denied' | 'quota' | 'timeout' | 'cancelled';
export interface ProjectListEntry {
    readonly path: string;
    readonly bytes: number;
    readonly directory: boolean;
}
export interface ProjectListQuery {
    /** Inclusive start index into the snapshot. */
    readonly offset?: number;
    /** Page size; capped at `LIMITS.projectListPage`. */
    readonly limit?: number;
    /** Restrict to this directory prefix (`src/`). */
    readonly prefix?: string;
}
export interface ProjectListResult {
    readonly status: ProjectListStatus;
    readonly snapshotId?: string;
    readonly entries?: readonly ProjectListEntry[];
    readonly total?: number;
    readonly offset?: number;
    readonly reason?: string;
}
/**
 * Bounded reads of known paths inside the approved project root: needs
 * `fs:project-read` declared, granted by the host and approved by the user
 * before activation. Limits: `LIMITS.projectFileBytes` per file,
 * `LIMITS.projectSessionBytes` and `LIMITS.projectReads` per session.
 * Listing needs `project:list`.
 */
export interface ProjectAccess {
    read(path: string): Promise<ProjectReadResult>;
    list(query?: ProjectListQuery): Promise<ProjectListResult>;
}
export type NetworkStatus = 'ok' | 'denied' | 'timeout' | 'too-large' | 'rate-limited' | 'cancelled' | 'error';
export interface NetworkRequest {
    readonly url: string;
    readonly method?: 'GET' | 'POST';
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
}
export interface NetworkResult {
    readonly status: NetworkStatus;
    readonly httpStatus?: number;
    readonly body?: string;
    readonly bytes?: number;
    readonly reason?: string;
}
/**
 * Brokered HTTP to one exact origin per grant. No ambient `fetch`. Never on
 * the key path. Address classification, one pinned resolution, no redirects.
 */
export interface NetworkAccess {
    request(spec: NetworkRequest): Promise<NetworkResult>;
}
export type GitStatus = 'ok' | 'denied' | 'timeout' | 'cancelled' | 'error';
export type GitQuery = {
    readonly kind: 'branch';
} | {
    readonly kind: 'status';
} | {
    readonly kind: 'log';
    readonly limit?: number;
} | {
    readonly kind: 'changed';
};
export interface GitResult {
    readonly status: GitStatus;
    readonly branch?: string;
    readonly dirty?: boolean;
    readonly ahead?: number;
    readonly behind?: number;
    readonly subjects?: readonly string[];
    readonly paths?: readonly string[];
    readonly reason?: string;
}
/** Read-only git queries served by the helper, never a guest process. */
export interface GitAccess {
    query(spec: GitQuery): Promise<GitResult>;
}
/** Delivered through `onProjectFileChange`; trust in a changed config file is revoked. */
export interface ProjectChange {
    readonly path: string;
    readonly version: number;
    readonly reason: 'changed' | 'approved';
}
/** Scheme, host and port of an exact origin grant. No userinfo, path, query or hash. */
export interface NetworkOrigin {
    readonly scheme: 'http' | 'https';
    readonly host: string;
    readonly port: number;
    readonly href: string;
}
/** True when `value` is an exact origin the network broker will pin. */
export declare function parseOrigin(value: string): NetworkOrigin | null;
export declare function isExactOrigin(value: string): boolean;
/** Context services an executor must route for the contract to hold (lesson 73). */
export declare const SERVICES: readonly ['clock', 'storage', 'project.read', 'project.list', 'network.request', 'git.query'];
export type PluginService = (typeof SERVICES)[number];

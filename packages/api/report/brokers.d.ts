/**
 * Storage results. `denied` carries a reason, e.g. `private mode` (phase 14).
 * `quota`: the write would exceed `LIMITS.storageBytes`, `LIMITS.storageKeys` or
 * `LIMITS.storageKeyUnits`.
 */
export interface StorageResult {
    readonly status: 'ok' | 'quota' | 'denied' | 'error';
    /** The stored JSON value for a successful `get`; absent when the key is unset. */
    readonly value?: unknown;
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
/**
 * Bounded reads of known paths inside the approved project root: needs
 * `fs:project-read` declared, granted by the host and approved by the user
 * before activation. Limits: `LIMITS.projectFileBytes` per file,
 * `LIMITS.projectSessionBytes` and `LIMITS.projectReads` per session. It is not
 * a listing, search or git service.
 */
export interface ProjectAccess {
    read(path: string): Promise<ProjectReadResult>;
}
/** Delivered through `onProjectFileChange`; trust in a changed config file is revoked. */
export interface ProjectChange {
    readonly path: string;
    readonly version: number;
    readonly reason: 'changed' | 'approved';
}
/** Context services an executor must route for the contract to hold (lesson 73). */
export declare const SERVICES: readonly ['clock', 'storage', 'project.read'];
export type PluginService = (typeof SERVICES)[number];

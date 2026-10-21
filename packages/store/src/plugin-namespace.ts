// The plugin storage contract of draft 2.0-pre (r12 K1), as pure functions on
// one namespace's data: JSON only, LIMITS.storageBytes of serialized UTF-8,
// LIMITS.storageKeys keys, LIMITS.storageKeyUnits UTF-16 units per key. The
// durable backend applies one key change to a freshly re-read namespace under
// its lock, so two sessions never erase each other's keys (phase 14 owns this
// multi-writer rule; the prototype was last-writer-wins, r14 D4).
import { LIMITS, type StorageResult } from '@murmo/api';
import { utf8Length } from './encoding.ts';

export type NamespaceData = Record<string, unknown>;

export const PRIVATE_MODE_REASON = 'private mode';

export function storageKeyProblem(key: unknown): string | null {
  if (typeof key !== 'string' || key.length === 0) return 'storage keys are non-empty strings';
  if (key.length > LIMITS.storageKeyUnits) return `storage keys are at most ${LIMITS.storageKeyUnits} UTF-16 units`;
  return null;
}

/** A detached JSON copy, or undefined when `value` has no JSON form. */
export function jsonCopy(value: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return undefined;
  }
  return text === undefined ? undefined : JSON.parse(text);
}

function own(data: NamespaceData, key: string): boolean {
  return Object.hasOwn(data, key);
}

export function storageGet(data: NamespaceData, key: string): StorageResult {
  const problem = storageKeyProblem(key);
  if (problem) return { status: 'denied', reason: problem };
  return own(data, key) ? { status: 'ok', value: jsonCopy(data[key]) } : { status: 'ok' };
}

export interface NamespaceChange {
  readonly result: StorageResult;
  /** The namespace to write, absent when nothing changes. */
  readonly next?: NamespaceData;
}

/** Sets one key on a copy of `data`, or refuses with the reason the plugin sees. */
export function storageSet(data: NamespaceData, key: string, value: unknown): NamespaceChange {
  const problem = storageKeyProblem(key);
  if (problem) return { result: { status: 'denied', reason: problem } };
  const copy = jsonCopy(value);
  if (copy === undefined) return { result: { status: 'denied', reason: 'storage values must be JSON' } };
  const next: NamespaceData = { ...data };
  Object.defineProperty(next, key, { value: copy, enumerable: true, writable: true, configurable: true });
  const quota = quotaProblem(next);
  return quota ? { result: { status: 'quota', reason: quota } } : { result: { status: 'ok' }, next };
}

export function storageDelete(data: NamespaceData, key: string): NamespaceChange {
  const problem = storageKeyProblem(key);
  if (problem) return { result: { status: 'denied', reason: problem } };
  if (!own(data, key)) return { result: { status: 'ok' } };
  const next: NamespaceData = { ...data };
  delete next[key];
  return { result: { status: 'ok' }, next };
}

export function quotaProblem(data: NamespaceData): string | null {
  if (Object.keys(data).length > LIMITS.storageKeys) return `plugin storage holds at most ${LIMITS.storageKeys} keys`;
  if (utf8Length(JSON.stringify(data)) > LIMITS.storageBytes) {
    return `plugin storage holds at most ${LIMITS.storageBytes} bytes of JSON`;
  }
  return null;
}

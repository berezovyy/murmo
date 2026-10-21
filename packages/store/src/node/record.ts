// Record files: read without a lock (a rename never shows a partial file),
// update as lock, re-read, apply, temp + rename. The re-read under the lock is
// what keeps two sessions from erasing each other's changes.

import { dirname } from 'node:path';
import { decodeRecord, encodeRecord, RECORD_MAX_BYTES, type RecordKind, type RecordTypes } from '../records.ts';
import { ensurePrivateDir, type ModeRepairs, readStoreFile, writeAtomic } from './files.ts';
import { type LockOptions, withLock } from './lock.ts';

export type RecordRead<K extends RecordKind> =
  | { readonly status: 'ok'; readonly record: RecordTypes[K] }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

export async function readRecord<K extends RecordKind>(
  kind: K,
  path: string,
  repairs?: ModeRepairs,
  maxBytes: number = RECORD_MAX_BYTES,
): Promise<RecordRead<K>> {
  const read = await readStoreFile(path, maxBytes, repairs);
  if (read.status !== 'ok') return read;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
  } catch {
    return { status: 'unreadable', reason: 'is not UTF-8' };
  }
  const record = decodeRecord(kind, text);
  return record ? { status: 'ok', record } : { status: 'unreadable', reason: `is not a ${kind} record` };
}

/** Returns the new record, or `{unchanged}` to leave the file as it is. */
export type RecordUpdate<K extends RecordKind, R> = (
  current: RecordTypes[K] | undefined,
) => { readonly record: RecordTypes[K]; readonly result: R } | { readonly unchanged: R };

export type UpdateResult<R> =
  | { readonly status: 'ok'; readonly result: R; readonly written: boolean; readonly reset: boolean }
  | { readonly status: 'busy' }
  | { readonly status: 'error'; readonly reason: string };

export interface UpdateOptions extends LockOptions {
  /** fsync file and directory: trust approvals and the allowlist (phase 14 design). */
  readonly durable?: boolean;
  readonly maxBytes?: number;
  /** The Murmo root the record lives under, for creating private directories. */
  readonly base: string;
  readonly repairs?: ModeRepairs;
}

/**
 * Applies `update` to the current record under its lock. An unreadable record
 * (hand-edited, foreign) is passed as undefined and replaced; `reset` says so.
 */
export async function updateRecord<K extends RecordKind, R>(
  kind: K,
  path: string,
  update: RecordUpdate<K, R>,
  options: UpdateOptions,
): Promise<UpdateResult<R>> {
  const maxBytes = options.maxBytes ?? RECORD_MAX_BYTES;
  try {
    await ensurePrivateDir(dirname(path), options.base, options.repairs);
    const outcome = await withLock(
      path,
      async (held): Promise<UpdateResult<R>> => {
        const current = await readRecord(kind, path, options.repairs, maxBytes);
        const change = update(current.status === 'ok' ? current.record : undefined);
        const reset = current.status === 'unreadable';
        if ('unchanged' in change) return { status: 'ok', result: change.unchanged, written: false, reset };
        const text = encodeRecord(change.record);
        if (Buffer.byteLength(text) > maxBytes)
          return { status: 'error', reason: `record would exceed ${maxBytes} bytes` };
        if (!(await held.stillHeld())) return { status: 'busy' };
        await writeAtomic(path, text, { durable: options.durable ?? false });
        return { status: 'ok', result: change.result, written: true, reset };
      },
      options,
    );
    return outcome.status === 'busy' ? outcome : outcome.value;
  } catch (error) {
    return { status: 'error', reason: (error as Error).message };
  }
}

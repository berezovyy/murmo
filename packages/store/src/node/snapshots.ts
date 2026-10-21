// Packed snapshots on disk. One file: built under a lock, swapped by rename,
// read through one open descriptor (r6: one fd for size and all chunks gave 0
// mixed generations in 105,000 lookups; re-opening by path mixed them).
//
// A set of files (history, phase 35): written whole into a fresh
// `snap-<generation>/`, then one small `current` pointer record is renamed
// into place. A reader resolves the pointer once and opens every file of that
// set, so it sees the old set or the new one, never a mix. r9's history store
// had no multi-file transaction (r9-history § Append and disk size).
import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { encodeRecord, type SnapshotPointer } from '../records.ts';
import { decodeSnapshot, encodeSnapshot, type Snapshot, type SnapshotFields } from '../snapshot.ts';
import {
  ensurePrivateDir,
  errorCode,
  type ModeRepairs,
  readHandle,
  readStoreFile,
  removeStaleTemps,
  repairOpenFile,
  syncDirectory,
  writeAtomic,
} from './files.ts';
import { type LockOptions, withLock } from './lock.ts';
import { readRecord } from './record.ts';

/** Snapshots may be large; this bounds a single file read. */
export const SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;

export type SnapshotRead =
  | { readonly status: 'ok'; readonly snapshot: Snapshot }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly reason: string };

export type SwapResult = { readonly status: 'ok'; readonly generation: number } | { readonly status: 'busy' };

export interface SnapshotPlace {
  readonly path: string;
  /** The Murmo root it lives under (data or cache). */
  readonly base: string;
  readonly repairs?: ModeRepairs;
}

/** Builds and swaps one snapshot file under its lock. */
export async function writeSnapshot(
  place: SnapshotPlace,
  fields: SnapshotFields,
  body: Uint8Array,
  options: LockOptions = {},
): Promise<SwapResult> {
  await ensurePrivateDir(dirname(place.path), place.base, place.repairs);
  const outcome = await withLock(
    place.path,
    async () => {
      await writeAtomic(place.path, encodeSnapshot(fields, body), { durable: true });
      return 0;
    },
    options,
  );
  return outcome.status === 'ok' ? { status: 'ok', generation: 0 } : outcome;
}

/** Reads one snapshot file through one descriptor and checks it. */
export async function readSnapshot(path: string, repairs?: ModeRepairs): Promise<SnapshotRead> {
  const read = await readStoreFile(path, SNAPSHOT_MAX_BYTES, repairs);
  if (read.status === 'missing') return read;
  if (read.status === 'unreadable') return { status: 'invalid', reason: read.reason };
  const decoded = decodeSnapshot(read.bytes);
  return decoded.ok ? { status: 'ok', snapshot: decoded.snapshot } : { status: 'invalid', reason: decoded.reason };
}

const SET_DIRECTORY = /^snap-[0-9]+$/;
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

export interface SnapshotSetPlace {
  /** The folder that holds `current` and the `snap-<n>` directories. */
  readonly directory: string;
  readonly base: string;
  readonly repairs?: ModeRepairs;
}

function pointerPath(directory: string): string {
  return join(directory, 'current');
}

export async function readPointer(directory: string, repairs?: ModeRepairs): Promise<SnapshotPointer | undefined> {
  const read = await readRecord('pointer', pointerPath(directory), repairs);
  return read.status === 'ok' ? read.record : undefined;
}

/**
 * Writes `files` as the next generation of the set and swaps `current` to it.
 * Before writing, it removes every `snap-*` directory except the current one:
 * the previous set (kept until now so readers that resolved it could finish)
 * and any half-written set of a killed swap.
 */
export async function swapSnapshotSet(
  place: SnapshotSetPlace,
  files: Readonly<Record<string, { readonly fields: SnapshotFields; readonly body: Uint8Array }>>,
  options: LockOptions = {},
): Promise<SwapResult> {
  for (const name of Object.keys(files)) {
    if (!FILE_NAME.test(name) || name === 'current') throw new Error(`invalid snapshot file name ${name}`);
  }
  await ensurePrivateDir(place.directory, place.base, place.repairs);
  const outcome = await withLock(
    pointerPath(place.directory),
    async () => {
      const pointer = await readPointer(place.directory, place.repairs);
      await removeStaleTemps(place.directory);
      for (const name of await fsp.readdir(place.directory)) {
        if (SET_DIRECTORY.test(name) && name !== pointer?.directory) {
          await fsp.rm(join(place.directory, name), { recursive: true, force: true });
        }
      }
      const generation = (pointer?.generation ?? 0) + 1;
      const directory = `snap-${generation}`;
      const target = join(place.directory, directory);
      await fsp.mkdir(target, { mode: 0o700 });
      await fsp.chmod(target, 0o700);
      const listed: Record<string, { bytes: number; sha256: string }> = {};
      for (const [name, file] of Object.entries(files)) {
        const bytes = encodeSnapshot(file.fields, file.body);
        await writeAtomic(join(target, name), bytes, { durable: true });
        const decoded = decodeSnapshot(bytes);
        if (!decoded.ok) throw new Error('snapshot did not round-trip');
        listed[name] = { bytes: bytes.length, sha256: decoded.snapshot.header.bodySha256 };
      }
      await syncDirectory(target);
      const next: SnapshotPointer = {
        schema: 1,
        generation,
        directory,
        ...(pointer ? { previous: pointer.directory } : {}),
        files: listed,
      };
      await writeAtomic(pointerPath(place.directory), encodeRecord(next), { durable: true });
      return generation;
    },
    options,
  );
  return outcome.status === 'ok' ? { status: 'ok', generation: outcome.value } : outcome;
}

export type SetRead =
  | { readonly status: 'ok'; readonly generation: number; readonly files: Readonly<Record<string, Snapshot>> }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly reason: string };

/**
 * Resolves `current` once and opens every file of that set before reading
 * any, so a later swap can remove the directory without tearing this read.
 * Each file's body must match the hash the pointer recorded. If the set was
 * removed between resolving and opening, the pointer is resolved once more.
 */
export async function readSnapshotSet(directory: string, repairs?: ModeRepairs): Promise<SetRead> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const pointer = await readPointer(directory, repairs);
    if (!pointer) return { status: 'missing' };
    const handles: [string, string, fsp.FileHandle][] = [];
    try {
      try {
        for (const name of Object.keys(pointer.files)) {
          const path = join(directory, pointer.directory, name);
          handles.push([
            name,
            path,
            await fsp.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
          ]);
        }
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      const files: Record<string, Snapshot> = {};
      for (const [name, path, handle] of handles) {
        const st = await repairOpenFile(handle, path, repairs);
        if (!st.isFile()) return { status: 'invalid', reason: `${name} is not a regular file` };
        const decoded = decodeSnapshot(await readHandle(handle, st.size));
        if (!decoded.ok) return { status: 'invalid', reason: `${name}: ${decoded.reason}` };
        if (decoded.snapshot.header.bodySha256 !== pointer.files[name]?.sha256) {
          return { status: 'invalid', reason: `${name} is from another generation` };
        }
        files[name] = decoded.snapshot;
      }
      return { status: 'ok', generation: pointer.generation, files };
    } finally {
      for (const [, , handle] of handles) await handle.close();
    }
  }
  return { status: 'invalid', reason: 'the snapshot set kept changing' };
}

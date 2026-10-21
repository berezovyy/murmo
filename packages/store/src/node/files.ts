// File primitives for the Node and Bun backend: private modes, atomic writes,
// bounded no-follow reads and stale temp cleanup. The Rust backend
// (rust/src/files.rs) uses the same temp names and modes, so either side
// cleans up after the other.
//
// Prior art this answers (knowledge § 7, lesson 4): settings written without
// an atomic write; world-readable state; a fixed `.tmp` sibling two writers
// share (r12 `createFileStorage`); temps left behind by a killed writer (r9).
import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
/** A temp file whose writer is gone, or that is older than this, is removed on open. */
export const STALE_TEMP_MS = 60 * 60 * 1000;

/** Every widened mode the store repaired, so the caller can report each one once. */
export interface ModeRepairs {
  readonly repaired: string[];
}

export function newRepairs(): ModeRepairs {
  return { repaired: [] };
}

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Temp names carry the writer's PID: `.<target>.<pid>.<16 hex>.tmp`. The PID
 * lets the next open remove a killed writer's temp at once instead of after an
 * hour, which the crash test requires ("no temp after the next open").
 */
const TEMP_NAME = /^\.(.+)\.([0-9]+)\.([0-9a-f]{16})\.tmp$/;

export function tempPath(target: string, label = ''): string {
  return join(dirname(target), `.${basename(target)}${label}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
}

export function isTempName(name: string): boolean {
  return TEMP_NAME.test(name);
}

/** True while a process with this PID exists (EPERM: it exists but isn't ours). */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

/**
 * Creates `dir` and its parents. Everything from `base` (one of the three
 * Murmo roots) down is 0700; parents above `base` are not Murmo's and keep the
 * default mode. An existing directory with a wider mode is repaired.
 */
export async function ensurePrivateDir(dir: string, base: string, repairs?: ModeRepairs): Promise<void> {
  const rel = relative(base, dir);
  if (rel.startsWith('..') || rel.startsWith(sep)) throw new Error(`${dir} is outside ${base}`);
  await fsp.mkdir(dirname(base), { recursive: true });
  let current = base;
  for (const part of ['', ...(rel ? rel.split(sep) : [])]) {
    current = part ? join(current, part) : current;
    try {
      await fsp.mkdir(current, { mode: DIR_MODE });
      await fsp.chmod(current, DIR_MODE); // the umask may have narrowed it differently
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      const st = await fsp.lstat(current);
      if (!st.isDirectory()) throw new Error(`${current} exists and is not a directory`);
      await repairMode(current, st, DIR_MODE, repairs);
    }
  }
}

async function repairMode(path: string, st: Stats, mode: number, repairs: ModeRepairs | undefined): Promise<void> {
  if ((st.mode & 0o777) === mode) return;
  await fsp.chmod(path, mode);
  repairs?.repaired.push(path);
}

/** Checks an open file's mode and repairs it when wider than 0600. */
export async function repairOpenFile(handle: fsp.FileHandle, path: string, repairs?: ModeRepairs): Promise<Stats> {
  const st = await handle.stat();
  if ((st.mode & 0o777) !== FILE_MODE) {
    await handle.chmod(FILE_MODE);
    repairs?.repaired.push(path);
  }
  return st;
}

export interface WriteOptions {
  /** fsync the file before the rename and the directory after it. */
  readonly durable?: boolean;
}

/**
 * Exclusive random sibling temp, every byte written, optional fsync, rename,
 * optional directory fsync. A reader sees the old file or the new one, never a
 * partial one; a killed writer leaves at most a temp the next open removes.
 */
export async function writeAtomic(
  target: string,
  data: Uint8Array | string,
  options: WriteOptions = {},
): Promise<void> {
  const temp = tempPath(target);
  const handle = await fsp.open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    FILE_MODE,
  );
  let renamed = false;
  try {
    await handle.chmod(FILE_MODE);
    await handle.writeFile(data);
    if (options.durable) await handle.sync();
    await handle.close();
    await fsp.rename(temp, target);
    renamed = true;
    if (options.durable) await syncDirectory(dirname(target));
  } finally {
    if (!renamed) {
      await handle.close().catch(() => {});
      await fsp.rm(temp, { force: true });
    }
  }
}

export async function syncDirectory(dir: string): Promise<void> {
  const handle = await fsp.open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type BoundedRead =
  | { readonly status: 'ok'; readonly bytes: Uint8Array; readonly stats: Stats }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

/**
 * Reads a store file through one descriptor: no symlink, a regular file, at
 * most `maxBytes`, mode repaired to 0600. O_NONBLOCK keeps a planted FIFO from
 * hanging the read.
 */
export async function readStoreFile(path: string, maxBytes: number, repairs?: ModeRepairs): Promise<BoundedRead> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', reason: code === 'ELOOP' ? 'is a symbolic link' : (code ?? 'open failed') };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { status: 'unreadable', reason: 'is not a regular file' };
    if (stats.size > maxBytes) return { status: 'unreadable', reason: `is larger than ${maxBytes} bytes` };
    await repairOpenFile(handle, path, repairs);
    return { status: 'ok', bytes: await readHandle(handle, stats.size), stats };
  } finally {
    await handle.close();
  }
}

/** Reads up to `size` bytes from offset 0 of an open file (fewer if it shrank). */
export async function readHandle(handle: fsp.FileHandle, size: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let at = 0;
  while (at < bytes.length) {
    const { bytesRead } = await handle.read(bytes, at, bytes.length - at, at);
    if (bytesRead === 0) break;
    at += bytesRead;
  }
  return at === bytes.length ? bytes : bytes.subarray(0, at);
}

/**
 * Removes temps in `dir` whose writer is dead or that are older than an hour.
 * A live writer's temp is left alone. Returns how many were removed.
 */
export async function removeStaleTemps(dir: string, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const match = TEMP_NAME.exec(name);
    if (!match) continue;
    const pid = Number(match[2]);
    const path = join(dir, name);
    let stale = !processAlive(pid);
    if (!stale) {
      try {
        stale = now - (await fsp.lstat(path)).mtimeMs > STALE_TEMP_MS;
      } catch {
        continue;
      }
    }
    if (stale) {
      await fsp.rm(path, { force: true, recursive: true });
      removed++;
    }
  }
  return removed;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fsp.lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

// One-fd load of protect-v1.bin: fstat + every byte through the same
// descriptor, then an immutable table object. Re-opening by path between
// chunks mixed generations in r6; this path does not.

import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decodeProtection, MAX_PROTECT_BYTES, PROTECT_FILE, type ProtectionTable } from '../index.ts';

export function protectPath(cacheDir: string): string {
  return join(cacheDir, PROTECT_FILE);
}

export function protectionMtime(cacheDir: string): number | undefined {
  try {
    return statSync(protectPath(cacheDir)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Reads size and bytes through one open fd, then validates the snapshot. */
export function readProtectionFd(fd: number): ProtectionTable {
  const size = fstatSync(fd).size;
  if (size > MAX_PROTECT_BYTES) throw new Error(`protection table is ${size} bytes, ceiling ${MAX_PROTECT_BYTES}`);
  const bytes = new Uint8Array(size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, bytes, off, size - off, off);
    if (n === 0) break;
    off += n;
  }
  const decoded = decodeProtection(off === size ? bytes : bytes.subarray(0, off));
  if (!decoded.ok) throw new Error(`protection table ${decoded.reason}`);
  return decoded.table;
}

export function readProtectionFile(path: string): ProtectionTable {
  const fd = openSync(path, 'r');
  try {
    return readProtectionFd(fd);
  } finally {
    closeSync(fd);
  }
}

export function tryReadProtection(cacheDir: string): ProtectionTable | undefined {
  try {
    return readProtectionFile(protectPath(cacheDir));
  } catch {
    return undefined;
  }
}

/**
 * Negative control for tests: a fresh path-open per chunk, which r6 showed
 * can mix two atomic generations.
 */
export function readProtectionByPathChunks(path: string, chunkBytes: number): Uint8Array {
  const size = statSync(path).size;
  const bytes = new Uint8Array(size);
  let off = 0;
  while (off < size) {
    const fd = openSync(path, 'r');
    try {
      const n = Math.min(chunkBytes, size - off);
      const got = readSync(fd, bytes, off, n, off);
      off += got;
      if (got === 0) break;
    } finally {
      closeSync(fd);
    }
  }
  return bytes;
}

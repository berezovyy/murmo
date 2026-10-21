// Packed protection membership: lang's sorted-ascii table as the body of a
// store snapshot whose header is `{format: 'murmo-protect-v1', entries, cacheKey}`.
// Sessions map one file through one fd and swap the object (r6 § 3).

import { encodeTable, findEntry, keyAt, mapTable, type PackedTable } from '@murmo/lang';
import { decodeSnapshot, encodeSnapshot } from '@murmo/store';
import { MAX_PROTECT_BYTES } from './limits.ts';
import { normalizeKey } from './normalize.ts';

export const PROTECT_FORMAT = 'murmo-protect-v1';
export const PROTECT_FILE = 'protect-v1.bin';
export const FILE_CACHE_DIR = 'vocab-cache-v1';
export const NAMES_FILE = 'names-v1.json';

export interface ProtectionTable {
  readonly format: typeof PROTECT_FORMAT;
  readonly entries: number;
  readonly cacheKey: string;
  readonly partial: boolean;
  readonly packed: PackedTable;
  /** Snapshot bytes, for atomic write. */
  readonly bytes: Uint8Array;
}

/** Sorted unique normalized keys; non-keys are dropped. */
export function normalizedKeys(words: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const word of words) {
    const key = normalizeKey(word);
    if (key) seen.add(key);
  }
  return [...seen].sort();
}

export function encodeProtection(options: {
  readonly keys: readonly string[];
  readonly cacheKey: string;
  readonly partial?: boolean;
}): Uint8Array {
  const keys = normalizedKeys(options.keys);
  const body = encodeTable(keys.map((key) => [key, '.'] as const));
  const bytes = encodeSnapshot(
    {
      format: PROTECT_FORMAT,
      sourceHash: options.cacheKey,
      entries: keys.length,
      cacheKey: options.cacheKey,
      partial: options.partial === true,
    },
    body,
  );
  if (bytes.byteLength > MAX_PROTECT_BYTES) {
    throw new Error(`protection table is ${bytes.byteLength} bytes, ceiling ${MAX_PROTECT_BYTES}`);
  }
  return bytes;
}

export type ProtectionDecode =
  | { readonly ok: true; readonly table: ProtectionTable }
  | { readonly ok: false; readonly reason: 'not-a-snapshot' | 'truncated' | 'checksum' | 'bad-body' };

export function decodeProtection(bytes: Uint8Array): ProtectionDecode {
  const decoded = decodeSnapshot(bytes);
  if (!decoded.ok) return decoded;
  const { header, body } = decoded.snapshot;
  if (header.format !== PROTECT_FORMAT || typeof header.cacheKey !== 'string') {
    return { ok: false, reason: 'not-a-snapshot' };
  }
  let packed: PackedTable;
  try {
    // Snapshot header length is not 4-byte aligned; mapTable needs an aligned view.
    const aligned = new Uint8Array(body.byteLength);
    aligned.set(body);
    packed = mapTable(aligned);
  } catch {
    return { ok: false, reason: 'bad-body' };
  }
  if (typeof header.entries === 'number' && header.entries !== packed.entries) {
    return { ok: false, reason: 'bad-body' };
  }
  return {
    ok: true,
    table: {
      format: PROTECT_FORMAT,
      entries: packed.entries,
      cacheKey: header.cacheKey,
      partial: header.partial === true,
      packed,
      bytes,
    },
  };
}

export function isProtectedKey(table: PackedTable, word: string): boolean {
  const key = normalizeKey(word);
  return key !== null && findEntry(table, key) >= 0;
}

export function protectionKeys(table: PackedTable): string[] {
  const out: string[] = [];
  for (let i = 0; i < table.entries; i++) out.push(keyAt(table, i));
  return out;
}

/**
 * Keys a session hands to inline rules: collision table ∪ sources 1–2.
 * Until the first table exists, `table` is undefined and only `extra` protects.
 */
export function protectedWords(table: PackedTable | undefined, extra: readonly string[] = []): string[] {
  const seen = new Set<string>(table ? protectionKeys(table) : []);
  for (const word of extra) {
    const key = normalizeKey(word);
    if (key) seen.add(key);
  }
  return [...seen];
}

// Packed snapshots: anything searched (vocabulary 19, phrases 34, history 35).
// A file is a magic, a JSON header and an opaque body (packed bytes plus a
// Uint32Array offset table, laid out by the phase that owns the contents). The
// header carries the schema, the source hash and a SHA-256 of the body, so a
// reader that can't hold one file handle across chunks (Claude's `$.fs`, at
// most 4 MiB per call) detects a mixed read, which r6 saw when re-opening by
// path between chunks (r6-vocab § 3).
import { sha256Hex, utf8Decode, utf8Encode } from './encoding.ts';

const MAGIC = [0x4d, 0x55, 0x52, 0x4d, 0x4f, 0x53, 0x4e, 0x31]; // "MURMOSN1"
const PREFIX_BYTES = 12;
/** Headers stay small; a bigger one means the file isn't ours. */
const MAX_HEADER_BYTES = 65_536;
/** One `$.fs` call reads at most 4 MiB (knowledge § 1). */
export const CHUNK_BYTES = 4 * 1024 * 1024;

export interface SnapshotHeader {
  readonly schema: 1;
  /** What the body is, e.g. `murmo-protect-v1`. */
  readonly format: string;
  /** Hash of the inputs it was built from; a mismatch means rebuild. */
  readonly sourceHash: string;
  readonly bodyBytes: number;
  readonly bodySha256: string;
  /** Format-specific fields (entry counts, cache keys). */
  readonly [extra: string]: unknown;
}

export interface Snapshot {
  readonly header: SnapshotHeader;
  readonly body: Uint8Array;
}

export type SnapshotFields = Omit<SnapshotHeader, 'schema' | 'bodyBytes' | 'bodySha256'>;

export function encodeSnapshot(fields: SnapshotFields, body: Uint8Array): Uint8Array {
  const header = utf8Encode(
    JSON.stringify({ ...fields, schema: 1, bodyBytes: body.length, bodySha256: sha256Hex(body) }),
  );
  if (header.length > MAX_HEADER_BYTES) throw new Error('snapshot header is larger than 64 KiB');
  const out = new Uint8Array(PREFIX_BYTES + header.length + body.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(8, header.length, true);
  out.set(header, PREFIX_BYTES);
  out.set(body, PREFIX_BYTES + header.length);
  return out;
}

export type SnapshotDecode =
  | { readonly ok: true; readonly snapshot: Snapshot }
  | { readonly ok: false; readonly reason: 'not-a-snapshot' | 'truncated' | 'checksum' };

/** Checks magic, header, length and body SHA-256. The body is a view into `bytes`. */
export function decodeSnapshot(bytes: Uint8Array): SnapshotDecode {
  if (bytes.length < PREFIX_BYTES || MAGIC.some((b, i) => bytes[i] !== b))
    return { ok: false, reason: 'not-a-snapshot' };
  const headerBytes = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  if (headerBytes > MAX_HEADER_BYTES) return { ok: false, reason: 'not-a-snapshot' };
  if (bytes.length < PREFIX_BYTES + headerBytes) return { ok: false, reason: 'truncated' };
  const text = utf8Decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + headerBytes));
  let header: SnapshotHeader;
  try {
    header = JSON.parse(text ?? '') as SnapshotHeader;
  } catch {
    return { ok: false, reason: 'not-a-snapshot' };
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    header.schema !== 1 ||
    typeof header.format !== 'string' ||
    typeof header.sourceHash !== 'string' ||
    !Number.isSafeInteger(header.bodyBytes) ||
    typeof header.bodySha256 !== 'string'
  ) {
    return { ok: false, reason: 'not-a-snapshot' };
  }
  const body = bytes.subarray(PREFIX_BYTES + headerBytes);
  if (body.length !== header.bodyBytes) return { ok: false, reason: 'truncated' };
  if (sha256Hex(body) !== header.bodySha256) return { ok: false, reason: 'checksum' };
  return { ok: true, snapshot: { header, body } };
}

/** Reads `length` bytes at `offset`; may return fewer at the end of the file. */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

/**
 * Reads a snapshot in `CHUNK_BYTES` calls when no stable file handle exists
 * (Claude). A file swapped by rename between two chunks fails the body check;
 * the whole read is retried once, then reported.
 */
export async function readSnapshotChunked(size: () => Promise<number>, read: ReadRange): Promise<SnapshotDecode> {
  let last: SnapshotDecode = { ok: false, reason: 'truncated' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const total = await size();
    const bytes = new Uint8Array(total);
    let at = 0;
    while (at < total) {
      const chunk = await read(at, Math.min(CHUNK_BYTES, total - at));
      if (chunk.length === 0) break;
      bytes.set(chunk.subarray(0, Math.min(chunk.length, total - at)), at);
      at += chunk.length;
    }
    last = decodeSnapshot(at === total ? bytes : bytes.subarray(0, at));
    if (last.ok || last.reason === 'not-a-snapshot') return last;
  }
  return last;
}

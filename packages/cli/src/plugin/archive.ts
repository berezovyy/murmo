// Plugin archive: gzip-or-tar, exact signed files, no links, no scripts.
// Limits from round 14 (E10): 2 MiB compressed, 4 MiB expanded, 1 MiB entry.

import { gunzipSync, gzipSync } from 'node:zlib';
import {
  ARCHIVE_COMPRESSED_MAX,
  ARCHIVE_ENTRY_MAX,
  ARCHIVE_EXPANDED_MAX,
  ENVELOPE_FILE,
  type InspectedPlugin,
  inspectPluginFiles,
  safeRelPath,
  sha256Bytes,
} from '@murmo/integrity';
import { fail } from './errors.ts';

const USTAR_MAGIC = Buffer.from('ustar\0');
const BLOCK = 512;

function headerString(block: Uint8Array, start: number, length: number): string {
  let end = start;
  const limit = start + length;
  while (end < limit && block[end] !== 0) end++;
  return Buffer.from(block.subarray(start, end)).toString('utf8');
}

function octal(block: Uint8Array, start: number, length: number): number {
  const text = headerString(block, start, length).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid-tar');
  return value;
}

function checksum(block: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (block[i] as number);
  return sum;
}

function isZero(block: Uint8Array): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

/** Unpack a plugin tarball (optionally gzipped). Rejects links, traversal and unsigned extras. */
export function unpackArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.byteLength > ARCHIVE_COMPRESSED_MAX) fail('archive-too-large', { bytes: bytes.byteLength });
  let tar: Uint8Array;
  try {
    tar = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: ARCHIVE_EXPANDED_MAX }) : bytes;
  } catch {
    fail('invalid-tar');
  }
  if (tar.byteLength > ARCHIVE_EXPANDED_MAX) fail('archive-too-large', { expanded: tar.byteLength });

  const files: Record<string, Uint8Array> = {};
  let offset = 0;
  while (offset + BLOCK <= tar.byteLength) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (isZero(header)) break;
    const expected = octal(header, 148, 8);
    if (checksum(header) !== expected) fail('invalid-tar');
    const name = headerString(header, 0, 100);
    const prefix = headerString(header, 345, 155);
    const kind = headerString(header, 156, 1) || '0';
    const size = octal(header, 124, 12);
    if (offset + BLOCK + size > tar.byteLength) fail('invalid-tar');
    const raw = `${prefix ? `${prefix}/` : ''}${name}`.replace(/\/$/, '');
    const rel = raw.replace(/^package\//, '');
    const payload = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (kind === '5') {
      if (size !== 0) fail('invalid-tar');
      continue;
    }
    if (kind === 'g' || kind === 'x') {
      // git archive pax/global headers; ignore after a size bound
      continue;
    }
    if (kind !== '0' && kind !== '') fail('archive-type-denied', { kind, raw });
    if (!safeRelPath(rel)) fail('unsafe-archive-path', { raw });
    if (size > ARCHIVE_ENTRY_MAX) fail('archive-too-large', { file: rel, bytes: size });
    if (Object.hasOwn(files, rel)) fail('duplicate-archive-path', { file: rel });
    files[rel] = Buffer.from(payload);
  }
  if (!files[ENVELOPE_FILE]) fail('manifest-missing');
  return files;
}

export function inspectArchive(bytes: Uint8Array): InspectedPlugin {
  return inspectPluginFiles(unpackArchive(bytes), sha256Bytes(bytes));
}

function writeOctal(block: Buffer, start: number, length: number, value: number): void {
  const text = `${value.toString(8).padStart(length - 1, '0')}\0`;
  block.write(text, start, length, 'utf8');
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  if (name.length > 100) fail('unsafe-archive-path', { raw: name });
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header.write('0', 156, 1, 'utf8');
  USTAR_MAGIC.copy(header, 257);
  header.write('00', 263, 2, 'utf8');
  const sum = checksum(header).toString(8).padStart(6, '0');
  header.write(`${sum}\0 `, 148, 8, 'utf8');
  return header;
}

/** Build a gzipped ustar of `files`. Used by tests and first-party packing. */
export function packTarGz(files: Readonly<Record<string, Uint8Array | string>>): Buffer {
  const chunks: Buffer[] = [];
  let expanded = 0;
  for (const [name, body] of Object.entries(files)) {
    if (!safeRelPath(name)) fail('unsafe-archive-path', { raw: name });
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    if (bytes.byteLength > ARCHIVE_ENTRY_MAX) fail('archive-too-large', { file: name, bytes: bytes.byteLength });
    expanded += bytes.byteLength + BLOCK;
    if (expanded > ARCHIVE_EXPANDED_MAX) fail('archive-too-large', { expanded });
    chunks.push(tarHeader(name, bytes.byteLength), bytes, Buffer.alloc((BLOCK - (bytes.byteLength % BLOCK)) % BLOCK));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  const tar = Buffer.concat(chunks);
  const gz = gzipSync(tar);
  if (gz.byteLength > ARCHIVE_COMPRESSED_MAX) fail('archive-too-large', { bytes: gz.byteLength });
  return gz;
}

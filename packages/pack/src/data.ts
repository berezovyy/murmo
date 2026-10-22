// Copy the English pack into data/en/. Reject magic 0 and a wrong entry count;
// never repair (r13 E16). provenance.csv stays out: 8.6 MB and unused at runtime.

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CASE_POLICY_FILE,
  MAX_DATA_BYTES,
  PACK_MANIFEST_FILE,
  PACK_NOTICE_FILE,
  SCOWL_COPYRIGHT_FILE,
  TABLE_FILE,
} from '@murmo/integrity';
import { HEADER_BYTES, mapTable, TABLE_MAGIC, validateTable } from '@murmo/lang';
import { ensurePack, PACK_FILES } from '@murmo/lang-en';

export class DataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataError';
  }
}

export interface PackedData {
  readonly sourceDir: string;
  readonly tableSha256: string;
  readonly entries: number;
  readonly bytes: number;
}

export function checkTableBytes(bytes: Uint8Array, expectedEntries?: number): { entries: number; magic: number } {
  if (bytes.byteLength < HEADER_BYTES) throw new DataError(`table is ${bytes.byteLength} bytes, shorter than a header`);
  const magic = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES).getUint32(0, true);
  if (magic === 0) throw new DataError(`table magic is 0; refusing to repair (need ${TABLE_MAGIC})`);
  if (magic !== TABLE_MAGIC) throw new DataError(`table magic ${magic} is not ${TABLE_MAGIC}`);
  const table = mapTable(bytes);
  validateTable(table);
  if (expectedEntries !== undefined && table.entries !== expectedEntries) {
    throw new DataError(`table has ${table.entries} entries, expected ${expectedEntries}`);
  }
  return { entries: table.entries, magic };
}

export function packLanguageData(packageDir: string, repoRoot: string): PackedData {
  const sourceDir = ensurePack();
  const tablePath = join(sourceDir, PACK_FILES.table);
  const bytes = new Uint8Array(readFileSync(tablePath));
  if (bytes.byteLength > MAX_DATA_BYTES) {
    throw new DataError(`${PACK_FILES.table} is ${bytes.byteLength} bytes; Claude $.fs reads cap at ${MAX_DATA_BYTES}`);
  }
  const expected = JSON.parse(readFileSync(join(repoRoot, 'packages/lang-en/expected.json'), 'utf8')) as {
    table: { entries: number; sha256: string };
  };
  const { entries } = checkTableBytes(bytes, expected.table.entries);
  const digest = sha256(bytes);
  if (digest !== expected.table.sha256) {
    throw new DataError(`table SHA-256 ${digest} != expected ${expected.table.sha256}`);
  }

  const copies: [string, string][] = [
    [PACK_FILES.table, TABLE_FILE],
    [PACK_FILES.casePolicy, CASE_POLICY_FILE],
    [PACK_FILES.manifest, PACK_MANIFEST_FILE],
    [PACK_FILES.notice, PACK_NOTICE_FILE],
    [PACK_FILES.scowlCopyright, SCOWL_COPYRIGHT_FILE],
  ];
  for (const [from, to] of copies) {
    const dest = join(packageDir, to);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(sourceDir, from), dest);
    const size = readFileSync(dest).byteLength;
    if (size > MAX_DATA_BYTES) throw new DataError(`${to} is ${size} bytes, over the 4 MiB $.fs cap`);
  }
  rewriteShippedManifest(packageDir);
  const packed = { sourceDir, tableSha256: digest, entries, bytes: bytes.byteLength };
  writeDataDigest(packageDir, packed);
  return packed;
}

/** lang-en builds `typos.bin`; the tarball ships it as `english.bin` (Claude $.fs path). */
export function rewriteShippedManifest(packageDir: string): void {
  const path = join(packageDir, PACK_MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { table?: { file?: string } };
  const tableName = TABLE_FILE.split('/').pop() ?? 'english.bin';
  if (!manifest.table || manifest.table.file === tableName) return;
  manifest.table.file = tableName;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Writes a digest setup's validation record must match (phase 27). */
export function writeDataDigest(packageDir: string, packed: PackedData): void {
  writeFileSync(
    join(packageDir, 'data/en/digest.json'),
    `${JSON.stringify({ sha256: packed.tableSha256, entries: packed.entries, bytes: packed.bytes }, null, 2)}\n`,
  );
}

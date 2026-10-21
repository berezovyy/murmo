// Node and Bun side of language packs: file reads, stat and native SHA-256 for
// the portable checks in ../pack.ts. `installLanguagePack` is what `murmo setup`
// and `murmo doctor` run (docs/plan/27); `openLanguagePack` is what an adapter
// runs at session start.

import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parseManifest } from '../manifest.ts';
import {
  type InstallRecord,
  installRecord,
  type OpenResult,
  openPack,
  PackError,
  type SessionFile,
  validatePack,
} from '../pack.ts';
import { decodeUtf8 } from '../utf8.ts';

export const MANIFEST_FILE = 'manifest.json';

export function nodeSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Reads a whole file into its own ArrayBuffer at offset 0, so the table's
 * Uint32 views can wrap it without a copy (a pooled Buffer may be misaligned).
 */
export function readFileAligned(path: string): SessionFile {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    const bytes = new Uint8Array(stat.size);
    for (let at = 0; at < bytes.length; ) {
      const n = readSync(fd, bytes, at, bytes.length - at, at);
      if (n === 0) throw new Error(`${path}: file shrank while it was read`);
      at += n;
    }
    return { bytes, mtimeMs: Math.trunc(stat.mtimeMs) };
  } finally {
    closeSync(fd);
  }
}

function readIfPresent(path: string): Uint8Array | undefined {
  try {
    return readFileAligned(path).bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export interface InstallResult {
  readonly record: InstallRecord;
  readonly recordFile: string;
}

/**
 * Full validation of the pack in `packDir`, then an atomic write of the install
 * record to `recordFile`. When the pack is not valid it throws `PackError` and
 * removes any older record, so no session keeps trusting the damaged files.
 */
export function installLanguagePack(
  packDir: string,
  recordFile: string,
  now: () => Date = () => new Date(),
): InstallResult {
  const manifestFile = join(packDir, MANIFEST_FILE);
  const manifestBytes = readIfPresent(manifestFile);
  if (!manifestBytes) {
    rmSync(recordFile, { force: true });
    throw new PackError('missing-file', `${manifestFile} is missing`);
  }
  let receipt: ReturnType<typeof validatePack>;
  try {
    receipt = validatePack(manifestBytes, (file) => readIfPresent(join(packDir, file)), nodeSha256);
  } catch (error) {
    rmSync(recordFile, { force: true });
    throw error;
  }
  const manifest = parseManifest(JSON.parse(decodeUtf8(manifestBytes)));
  const mtime = (file: string) => Math.trunc(statSync(join(packDir, file)).mtimeMs);
  const record = installRecord(
    receipt,
    { manifest: mtime(MANIFEST_FILE), table: mtime(manifest.table.file), casePolicy: mtime(manifest.casePolicy.file) },
    now().toISOString(),
  );
  mkdirSync(dirname(recordFile), { recursive: true });
  const temp = `${recordFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  renameSync(temp, recordFile);
  return { record, recordFile };
}

export interface OpenOptions {
  /** Check the table and case-policy SHA-256 with native crypto (default true; about 1 ms for 2 MiB). */
  readonly hash?: boolean;
}

/** Session start. Never throws for a bad pack: the result says why correction is off. */
export function openLanguagePack(packDir: string, recordFile: string, options: OpenOptions = {}): OpenResult {
  let manifest: SessionFile;
  try {
    manifest = readFileAligned(join(packDir, MANIFEST_FILE));
  } catch (error) {
    return { ok: false, problem: 'missing-file', reason: `${MANIFEST_FILE}: ${(error as Error).message}` };
  }
  let tableFile: string;
  let caseFile: string;
  try {
    const parsed = parseManifest(JSON.parse(decodeUtf8(manifest.bytes)));
    tableFile = parsed.table.file;
    caseFile = parsed.casePolicy.file;
  } catch {
    // openPack reports the manifest problem with its reason.
    return openPack(
      {
        manifest,
        table: { bytes: new Uint8Array(0), mtimeMs: 0 },
        casePolicy: { bytes: new Uint8Array(0), mtimeMs: 0 },
        record: undefined,
      },
      undefined,
    );
  }
  let table: SessionFile;
  let casePolicy: SessionFile;
  try {
    table = readFileAligned(join(packDir, tableFile));
    casePolicy = readFileAligned(join(packDir, caseFile));
  } catch (error) {
    return { ok: false, problem: 'missing-file', reason: (error as Error).message };
  }
  return openPack(
    { manifest, table, casePolicy, record: readIfPresent(recordFile) },
    options.hash === false ? undefined : nodeSha256,
  );
}

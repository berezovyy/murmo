import { createHash } from 'node:crypto';
import { chmodSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './canonical.ts';
import { INTEGRITY_FILE, SIGNATURE_FILE } from './layout.ts';

export const INTEGRITY_SCHEMA = 1 as const;

export interface IntegrityFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly mode: number;
}

export interface IntegrityManifest {
  readonly schema: typeof INTEGRITY_SCHEMA;
  readonly version: string;
  readonly commit: string;
  readonly keyId: string;
  readonly compatSha256: string;
  readonly files: readonly IntegrityFile[];
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isMetaFile(rel: string): boolean {
  return rel === INTEGRITY_FILE || rel === SIGNATURE_FILE;
}

/** POSIX path relative to `root`, sorted, skipping integrity files and junk. */
export function listPackageFiles(root: string): string[] {
  const out: string[] = [];
  visit(root, '', out);
  return out.sort();
}

function visit(dir: string, rel: string, out: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name === 'signing') continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) visit(path, child, out);
    else if (entry.isFile() && !isMetaFile(child)) out.push(child);
  }
}

export function hashFile(root: string, rel: string): { size: number; sha256: string; mode: number } {
  const path = join(root, rel);
  const st = statSync(path);
  const bytes = readFileSync(path);
  return { size: bytes.byteLength, sha256: sha256Bytes(bytes), mode: st.mode & 0o777 };
}

export function applyMode(root: string, rel: string, mode: number): void {
  chmodSync(join(root, rel), mode);
}

export function buildManifest(
  root: string,
  meta: { version: string; commit: string; keyId: string; compatSha256: string },
): IntegrityManifest {
  const files = listPackageFiles(root).map((path) => ({ path, ...hashFile(root, path) }));
  return { schema: INTEGRITY_SCHEMA, ...meta, files };
}

export function parseManifest(json: unknown): IntegrityManifest {
  const o = json as Partial<IntegrityManifest> | null;
  if (!o || o.schema !== INTEGRITY_SCHEMA || typeof o.version !== 'string') {
    throw new Error('integrity.json is not a schema-1 Murmo manifest');
  }
  if (typeof o.commit !== 'string' || typeof o.keyId !== 'string' || typeof o.compatSha256 !== 'string') {
    throw new Error('integrity.json is missing commit, keyId or compatSha256');
  }
  if (!Array.isArray(o.files)) throw new Error('integrity.json files must be an array');
  const files: IntegrityFile[] = [];
  for (const f of o.files) {
    if (!f || typeof f.path !== 'string' || typeof f.sha256 !== 'string')
      throw new Error('integrity.json file entry is invalid');
    if (typeof f.size !== 'number' || typeof f.mode !== 'number')
      throw new Error(`integrity.json ${f.path} is missing size or mode`);
    files.push({ path: f.path, size: f.size, sha256: f.sha256, mode: f.mode });
  }
  return {
    schema: INTEGRITY_SCHEMA,
    version: o.version,
    commit: o.commit,
    keyId: o.keyId,
    compatSha256: o.compatSha256,
    files,
  };
}

/** Lookup used by adapters that stored hashes as a map in the prototypes. */
export function fileByPath(manifest: IntegrityManifest, path: string): IntegrityFile | undefined {
  return manifest.files.find((f) => f.path === path);
}

export function manifestJson(manifest: IntegrityManifest): string {
  return `${canonicalJson(manifest)}\n`;
}

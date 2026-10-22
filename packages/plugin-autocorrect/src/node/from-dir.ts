// Load a already-built pack directory. The shipped tarball uses data/en/english.bin;
// lang-en's ensurePack writes typos.bin. Never builds, never repairs a header.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCasePolicy, parseManifest } from '@murmo/lang';
import { installEnglishPolicy } from '../rules.ts';
import { type EnglishPackAsset, provideEnglishPack } from '../table-source.ts';

function alignedCopy(source: Uint8Array): Uint8Array {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function tableFileIn(dir: string): string {
  for (const name of ['english.bin', 'typos.bin']) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  throw new Error(`no english.bin or typos.bin in ${dir}`);
}

/** Packed tarball `data/en`, or `MURMO_PACKAGE_ROOT/data/en`. */
export function findShippedEnglishDir(start = dirname(fileURLToPath(import.meta.url))): string | undefined {
  const override = process.env.MURMO_PACKAGE_ROOT;
  if (override) {
    const dir = join(override, 'data/en');
    if (existsSync(join(dir, 'english.bin')) || existsSync(join(dir, 'typos.bin'))) return dir;
  }
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'data/en');
    if (existsSync(join(candidate, 'english.bin')) || existsSync(join(candidate, 'typos.bin'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Reads a built pack dir and installs the English policy. Does not generate data. */
export function loadBuiltPack(dir: string): EnglishPackAsset {
  const tableBytes = alignedCopy(readFileSync(tableFileIn(dir)));
  const manifestPath = join(dir, 'manifest.json');
  const entries = existsSync(manifestPath)
    ? parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8'))).table.entries
    : new DataView(tableBytes.buffer, tableBytes.byteOffset, 8).getUint32(4, true);
  const casePath = join(dir, 'case-policy.json');
  const policy = existsSync(casePath)
    ? parseCasePolicy(JSON.parse(readFileSync(casePath, 'utf8')))
    : { lowercaseOnly: new Set<string>() };
  const lowercaseOnly = [...policy.lowercaseOnly];
  const asset: EnglishPackAsset = { bytes: tableBytes, sha256: sha256(tableBytes), entries, lowercaseOnly };
  provideEnglishPack(asset);
  installEnglishPolicy(policy.lowercaseOnly);
  return asset;
}

// Load a already-built pack directory. The shipped tarball uses data/en/english.bin;
// lang-en's ensurePack writes typos.bin. Never builds, never repairs a header.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
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

function englishDirIfPresent(root: string | undefined): string | undefined {
  if (!root) return undefined;
  const dir = join(root, 'data/en');
  if (existsSync(join(dir, 'english.bin')) || existsSync(join(dir, 'typos.bin'))) return dir;
  return undefined;
}

function installedPackageRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const xdg = env.XDG_DATA_HOME;
  const home = env.HOME;
  const dataHome = xdg && isAbsolute(xdg) ? xdg : home && isAbsolute(home) ? join(home, '.local', 'share') : undefined;
  return dataHome ? join(dataHome, 'murmo', 'package') : undefined;
}

/** Packed tarball `data/en`, `MURMO_PACKAGE_ROOT/data/en`, or the setup payload. */
export function findShippedEnglishDir(start = dirname(fileURLToPath(import.meta.url))): string | undefined {
  const fromEnv = englishDirIfPresent(process.env.MURMO_PACKAGE_ROOT);
  if (fromEnv) return fromEnv;
  const installed = englishDirIfPresent(installedPackageRoot());
  if (installed) return installed;
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const candidate = englishDirIfPresent(dir);
    if (candidate) return candidate;
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

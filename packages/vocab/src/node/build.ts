// Protection table builder: tracked files, manifests, CSpell, paths, whole
// identifiers; intersect with lang-en typo keys; pack and write atomically.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findEntry, type PackedTable } from '@murmo/lang';
import { sha256Hex } from '@murmo/store';
import { writeAtomic } from '@murmo/store/node';
import {
  basenameStem,
  EXCLUSION_VERSION,
  EXTRACTOR_VERSION,
  encodeProtection,
  FILE_CACHE_DIR,
  isCspellPath,
  isManifestPath,
  isSourcePath,
  LIMITS_VERSION,
  MAX_FILE_BYTES,
  MAX_READ_BYTES,
  NAMES_FILE,
  NORMALIZE_VERSION,
  normalizeKey,
  PROTECT_FILE,
  termsFromFile,
} from '../index.ts';
import { type FileCache, loadFileCache, saveFileCache, signatureOf } from './cache.ts';
import { listTracked, lstatFile } from './tracked.ts';

const hashHex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface BuildInput {
  readonly root: string;
  readonly cacheDir: string;
  readonly typo: PackedTable;
  readonly typoHash: string;
  /** Overlay path → file, for incremental tests that must not edit the clone. */
  readonly overrides?: ReadonlyMap<string, string>;
}

export interface BuildResult {
  readonly keys: readonly string[];
  readonly names: readonly string[];
  readonly cacheKey: string;
  readonly partial: boolean;
  readonly bytes: Uint8Array;
  readonly cache: FileCache;
  readonly reused: number;
  readonly scanned: number;
  readonly readBytes: number;
  readonly tracked: number;
  readonly via: 'git' | 'walk';
}

function pathTokens(posixPath: string): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const key = normalizeKey(raw);
    if (key) out.push(key);
  };
  for (const part of posixPath.split('/')) {
    if (part) add(part);
  }
  add(basenameStem(posixPath));
  return out;
}

function needsRead(posixPath: string): boolean {
  return isSourcePath(posixPath) || isManifestPath(posixPath) || isCspellPath(posixPath);
}

function cacheKeyOf(parts: { typoHash: string; listingHash: string; manifestHash: string }): string {
  return sha256Hex(
    Buffer.from(
      JSON.stringify({
        extractor: EXTRACTOR_VERSION,
        normalize: NORMALIZE_VERSION,
        exclusions: EXCLUSION_VERSION,
        limits: LIMITS_VERSION,
        table: parts.typoHash,
        listing: parts.listingHash,
        manifests: parts.manifestHash,
      }),
      'utf8',
    ),
  );
}

function consider(posixPath: string, tokens: readonly string[], names: Set<string>): void {
  for (const token of tokens) names.add(token);
  for (const token of pathTokens(posixPath)) names.add(token);
}

/**
 * Walks the repository, reuses the per-file cache when signatures match, and
 * returns the packed protection table (sources 3–6 ∩ typo keys).
 */
export function buildProtection(input: BuildInput): BuildResult {
  const listing = listTracked(input.root, hashHex);
  const previous = loadFileCache(input.cacheDir);
  const next: FileCache = new Map();
  const names = new Set<string>();
  const extraDictionaries: string[] = [];
  let reused = 0;
  let scanned = 0;
  let readBytes = 0;
  let partial = listing.truncated;
  const manifestParts: string[] = [];

  const readOne = (posixPath: string, forceRead: boolean): void => {
    const file = input.overrides?.get(posixPath) ?? join(input.root, posixPath);
    const st = lstatFile(file);
    if (!st?.regular) return;
    const readable = forceRead || needsRead(posixPath);
    if (st.size > MAX_FILE_BYTES && readable) {
      partial = true;
      return;
    }
    const signature = signatureOf(st);
    const old = previous.get(posixPath);
    if (old && old.signature === signature) {
      next.set(posixPath, old);
      consider(posixPath, old.tokens, names);
      reused++;
      return;
    }
    let tokens: string[] = [];
    if (readable) {
      if (readBytes + st.size > MAX_READ_BYTES) {
        partial = true;
        return;
      }
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return;
      }
      readBytes += st.size;
      const extracted = termsFromFile(posixPath, text);
      tokens = extracted.tokens;
      extraDictionaries.push(...extracted.dictionaries);
      if (isManifestPath(posixPath) || isCspellPath(posixPath)) {
        manifestParts.push(posixPath, signature, hashHex(Buffer.from(text, 'utf8')));
      }
    } else {
      tokens = pathTokens(posixPath);
    }
    next.set(posixPath, { signature, tokens });
    consider(posixPath, tokens, names);
    scanned++;
  };

  for (const posixPath of listing.paths) {
    if (partial && readBytes >= MAX_READ_BYTES) break;
    readOne(posixPath, false);
  }
  for (const dict of [...extraDictionaries]) {
    if (next.has(dict)) continue;
    readOne(dict, true);
  }

  const keys = [...names].filter((key) => findEntry(input.typo, key) >= 0).sort();
  const key = cacheKeyOf({
    typoHash: input.typoHash,
    listingHash: listing.hash,
    manifestHash: hashHex(Buffer.from(manifestParts.join('\0'), 'utf8')),
  });
  const bytes = encodeProtection({ keys, cacheKey: key, partial });
  return {
    keys,
    names: [...names].sort(),
    cacheKey: key,
    partial,
    bytes,
    cache: next,
    reused,
    scanned,
    readBytes,
    tracked: listing.paths.length,
    via: listing.via,
  };
}

/** Writes the packed table, names list and per-file cache. */
export async function commitBuild(cacheDir: string, result: BuildResult): Promise<string> {
  mkdirSync(join(cacheDir, FILE_CACHE_DIR), { recursive: true, mode: 0o700 });
  saveFileCache(cacheDir, result.cache);
  writeFileSync(join(cacheDir, NAMES_FILE), `${JSON.stringify({ names: result.names })}\n`);
  const target = join(cacheDir, PROTECT_FILE);
  await writeAtomic(target, result.bytes);
  return target;
}

/** Build, then persist. */
export async function buildAndWrite(input: BuildInput): Promise<BuildResult & { readonly path: string }> {
  const result = buildProtection(input);
  const path = await commitBuild(input.cacheDir, result);
  return { ...result, path };
}

// Per-file token cache keyed by size:mtime:inode (docs/plan/19). Stores names
// only, never source lines.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_CACHE_DIR } from '../index.ts';

export interface FileCacheEntry {
  readonly signature: string;
  readonly tokens: readonly string[];
}

export type FileCache = Map<string, FileCacheEntry>;

export function signatureOf(st: { size: number; mtimeMs: number; ino: string }): string {
  return `${st.size}:${st.mtimeMs}:${st.ino}`;
}

export function cacheFile(cacheDir: string): string {
  return join(cacheDir, FILE_CACHE_DIR, 'files.json');
}

export function loadFileCache(cacheDir: string): FileCache {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(cacheDir), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return new Map();
    const out: FileCache = new Map();
    for (const row of raw) {
      if (!Array.isArray(row) || row.length !== 2) continue;
      const [path, entry] = row as [unknown, unknown];
      if (typeof path !== 'string' || typeof entry !== 'object' || entry === null) continue;
      const rec = entry as { signature?: unknown; tokens?: unknown };
      if (typeof rec.signature !== 'string' || !Array.isArray(rec.tokens)) continue;
      if (!rec.tokens.every((t) => typeof t === 'string')) continue;
      out.set(path, { signature: rec.signature, tokens: rec.tokens });
    }
    return out;
  } catch {
    return new Map();
  }
}

export function saveFileCache(cacheDir: string, cache: FileCache): void {
  const rows = [...cache].map(([path, entry]) => [path, { signature: entry.signature, tokens: [...entry.tokens] }]);
  writeFileSync(cacheFile(cacheDir), `${JSON.stringify(rows)}\n`);
}

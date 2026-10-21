// Freezes the protected project terms from round 6's vocabulary caches into
// inputs/project-terms.txt.gz. Round 7 read the caches live
// (experiments/vocab/data/*.cache.json, 86 MB of per-file records), which made
// the table depend on files outside the repo; the build now reads only this
// frozen word list. Same extraction as round 7's prepare.py: every path term
// and identifier whose lowercase form is ASCII letters only.

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

type CacheRow = [path: string, item: { terms?: [string, ...unknown[]][]; ids?: string[] }];

export function extractProjectTerms(cacheFiles: readonly string[]): string[] {
  const terms = new Set<string>();
  const add = (term: unknown) => {
    if (typeof term !== 'string') return;
    const lower = term.toLowerCase();
    if (/^[a-z]+$/.test(lower)) terms.add(lower);
  };
  for (const file of cacheFiles) {
    const rows = JSON.parse(readFileSync(file, 'utf8')) as CacheRow[];
    for (const [, item] of rows) {
      for (const [term] of item.terms ?? []) add(term);
      for (const id of item.ids ?? []) add(id);
    }
  }
  return [...terms].sort();
}

/** Writes the sorted list, one term per line, gzip-compressed; returns the term count. */
export function freezeProjectTerms(cacheFiles: readonly string[], out: string): number {
  const terms = extractProjectTerms(cacheFiles);
  writeFileSync(out, gzipSync(terms.map((t) => `${t}\n`).join(''), { level: 9 }));
  return terms.length;
}

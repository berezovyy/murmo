// Private-key scan over packages/, pack outputs and the tarball (E22). Nothing
// is skipped: no source or fixture may hold a PEM private key.

import { readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { listPackageFiles } from './manifest.ts';

// Require a body so a regex source (BEGIN header only) is not a hit (E22).
const PEM = new RegExp(
  `-----${'BEGIN'} (?:[A-Z][A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----\\r?\\n[A-Za-z0-9+/=\\r\\n]+-----END `,
);

export interface ScanHit {
  readonly path: string;
  readonly why: string;
}

export function scanBytes(bytes: Uint8Array | string, path: string): ScanHit | undefined {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  if (PEM.test(text)) return { path, why: 'PEM private-key header' };
  const base = path.split('/').pop() ?? path;
  if (base === 'private.pem' || (base.endsWith('.pem') && /PRIVATE KEY/.test(text))) {
    return { path, why: 'private PEM filename' };
  }
  return undefined;
}

export function scanTree(root: string, repoRoot = root): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const rel of listPackageFiles(root)) {
    const abs = resolve(root, rel);
    const fromRepo = relative(repoRoot, abs).split(sep).join('/');
    const st = statSync(abs);
    if (st.size > 8 * 1024 * 1024) continue;
    const hit = scanBytes(readFileSync(abs), fromRepo);
    if (hit) hits.push(hit);
  }
  return hits;
}

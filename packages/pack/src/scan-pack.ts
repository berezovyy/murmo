import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ScanHit, scanTree } from '@murmo/integrity';

export function scanRelease(repoRoot: string, packageDir: string, tarball: string): ScanHit[] {
  const hits = [...scanTree(join(repoRoot, 'packages'), repoRoot), ...scanTree(packageDir)];
  const extract = mkdtempSync(join(tmpdir(), 'murmo-scan-tgz-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', extract]);
    hits.push(...scanTree(join(extract, 'package')));
  } finally {
    rmSync(extract, { recursive: true, force: true });
  }
  return hits;
}

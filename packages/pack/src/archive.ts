import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TGZ_BYTES, MAX_UNPACKED_BYTES, PACKAGE_NAME, PACKAGE_VERSION } from '@murmo/integrity';

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export function npmPack(packageDir: string, destDir: string): string {
  const cache = mkdtempSync(join(tmpdir(), 'murmo-npm-pack-'));
  try {
    const json = execFileSync(
      'npm',
      ['pack', packageDir, '--pack-destination', destDir, '--json', '--cache', cache, '--ignore-scripts'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(json) as { filename?: string }[] | { filename?: string };
    const filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed.filename;
    const name = filename ?? `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`;
    return join(destDir, name);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

export function unpackedSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += unpackedSize(path);
    else total += statSync(path).size;
  }
  return total;
}

export function checkSizes(tarball: string, unpackedDir: string): { compressed: number; unpacked: number } {
  const compressed = statSync(tarball).size;
  if (compressed > MAX_TGZ_BYTES) throw new ArchiveError(`tarball is ${compressed} bytes, over the 8 MB target`);
  const unpacked = unpackedSize(unpackedDir);
  if (unpacked > MAX_UNPACKED_BYTES) throw new ArchiveError(`unpacked size ${unpacked} bytes, over the 16 MB target`);
  return { compressed, unpacked };
}

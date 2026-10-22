import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTEGRITY_FILE, npmPlatform } from '@murmo/integrity';

export function here(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Packed tarball root (integrity.json) or this source package. */
export function packageRoot(start = here()): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, INTEGRITY_FILE)) && existsSync(join(dir, 'package.json'))) return dir;
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src', 'cli.ts'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('not inside a murmo package');
    dir = parent;
  }
}

export function platformBin(name: string, root = packageRoot()): string {
  return join(root, 'bin', npmPlatform(), name);
}

// Workspace discovery shared by the build, check and license tools.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));

const packageGlobs = ['packages', 'packages/adapters', 'packages/plugins'];

/** @returns {{dir: string, manifest: any}[]} every workspace package with a package.json */
export function listPackages(base = root) {
  const found = [];
  for (const glob of packageGlobs) {
    const parent = join(base, glob);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(parent, entry.name);
      const file = join(dir, 'package.json');
      if (!existsSync(file)) continue;
      found.push({ dir, manifest: JSON.parse(readFileSync(file, 'utf8')) });
    }
  }
  for (const extra of ['fixtures']) {
    const file = join(base, extra, 'package.json');
    if (existsSync(file)) found.push({ dir: join(base, extra), manifest: JSON.parse(readFileSync(file, 'utf8')) });
  }
  return found.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/** Names a package may import: its own dependencies of every kind. */
export function declaredDependencies(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

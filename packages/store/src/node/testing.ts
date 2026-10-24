// Tests only: put a plugin folder into a store the way `murmo plugin add`
// leaves it (plugins.json selection, extensions/<id>/<digest>/ files with the
// envelope's file hashes), without signing. Adapter tests use it to prove a
// session loads what the CLI installed.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Permission } from '@murmo/api';
import { extensionsDir, pluginsManifestPath, type StoreRoots } from '../layout.ts';
import type { PluginsManifest } from '../plugins.ts';
import { defaultManifest } from './distribution.ts';

export interface TestInstall {
  readonly grants: readonly Permission[];
  readonly enabled?: boolean;
  /** Built-ins to mark disabled, as `murmo plugin disable <id>` does. */
  readonly disabled?: readonly string[];
}

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Returns the generation folder; plugins.json is rewritten each call. */
export function installForTest(roots: Pick<StoreRoots, 'data'>, folder: string, options: TestInstall): string {
  const manifestBytes = readFileSync(join(folder, 'murmo.plugin.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { name: string; version: string; entry: string };
  const entryBytes = readFileSync(join(folder, manifest.entry));
  const files = { 'murmo.plugin.json': sha(manifestBytes), [manifest.entry]: sha(entryBytes) };
  const digest = sha(JSON.stringify(files));
  const dir = extensionsDir(roots as StoreRoots, manifest.name, digest);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'murmo.plugin.json'), manifestBytes);
  writeFileSync(join(dir, manifest.entry), entryBytes);
  const base = defaultManifest();
  const plugins = { ...base.plugins };
  for (const id of options.disabled ?? []) plugins[id] = { enabled: false, builtin: true, grants: [] };
  plugins[manifest.name] = {
    enabled: options.enabled !== false,
    grants: [...options.grants],
    entry: `${dir}/${manifest.entry}`,
    distribution: {
      digest,
      publisher: 'f'.repeat(64),
      manifest: { id: manifest.name, version: manifest.version, entry: manifest.entry, files },
      source: { kind: 'folder', spec: folder },
    },
  };
  const selection: PluginsManifest = { ...base, revision: 1, order: [...base.order, manifest.name], plugins };
  writeFileSync(pluginsManifestPath(roots as StoreRoots), `${JSON.stringify(selection, null, 2)}\n`);
  return dir;
}

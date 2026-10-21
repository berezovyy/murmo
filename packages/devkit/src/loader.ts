// Manifest preflight and entry loading before any plugin factory runs
// (lesson 73, K1). Symlink escapes are refused.

import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  type Capabilities,
  MANIFEST_FILE,
  type Negotiation,
  negotiate,
  type PluginManifest,
  resolveSettings,
  validateManifest,
} from '@murmo/api';
import type { HostCapabilities } from '@murmo/api/adapter';

const MANIFEST_MAX_BYTES = 64 * 1024;
const ENTRY_MAX_BYTES = 1024 * 1024;

export interface PreparedPlugin {
  readonly root: string;
  readonly entry: string;
  readonly source: string;
  readonly manifest: PluginManifest;
  readonly negotiation: Negotiation;
  readonly settings: Readonly<Record<string, unknown>>;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !rel.startsWith(`..`) && !isAbsolute(rel);
}

export async function preparePlugin(
  directory: string,
  options: { caps: Capabilities | HostCapabilities; settings?: Readonly<Record<string, unknown>> },
): Promise<PreparedPlugin> {
  const root = await realpath(resolve(directory));
  const manifestPath = resolve(root, MANIFEST_FILE);
  const manifestReal = await realpath(manifestPath);
  if (!inside(root, manifestReal)) throw new Error('manifest escapes plugin package');
  const manifestStat = await stat(manifestReal);
  if (!manifestStat.isFile() || manifestStat.size > MANIFEST_MAX_BYTES) {
    throw new Error('manifest exceeds 64 KiB');
  }
  const manifest = validateManifest(JSON.parse(await readFile(manifestReal, 'utf8')));
  const negotiation = negotiate(manifest, options.caps as Capabilities);
  const settings = resolveSettings(manifest, options.settings ?? {});
  const entry = await realpath(resolve(root, manifest.entry));
  if (!inside(root, entry)) throw new Error('entry escapes plugin package');
  const entryStat = await stat(entry);
  if (!entryStat.isFile() || entryStat.size > ENTRY_MAX_BYTES) {
    throw new Error('entry must be a regular file <=1 MiB');
  }
  const source = await readFile(entry, 'utf8');
  return { root, entry, source, manifest, negotiation, settings };
}

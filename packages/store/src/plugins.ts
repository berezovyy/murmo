// What `murmo plugin` selected, read by every adapter when a session starts:
// `<data>/plugins.json` names the installed generation of each plugin, its
// reviewed grants and the order. Third-party code comes from
// `<data>/extensions/<id>/<digest>/`, checked against the file hashes the
// signed envelope carried at install, so a half-written or damaged
// generation never loads. Portable: Claude reads through its host's file API.

import { type Permission, type PluginManifest, validateManifest } from '@murmo/api';
import { sha256Hex, utf8Decode, utf8Encode } from './encoding.ts';
import { extensionsDir, pluginsManifestPath, type StoreRoots } from './layout.ts';

export const PLUGINS_SCHEMA = 1;

export interface PluginSource {
  /** `folder`: a local plugin folder signed with the user's development key. */
  readonly kind: 'tarball' | 'git' | 'npm' | 'folder';
  readonly spec: string;
  readonly path?: string;
  readonly url?: string;
  readonly commit?: string;
  readonly registry?: string;
  readonly integrity?: string;
}

export interface PluginDistribution {
  readonly digest: string;
  readonly publisher: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly source: PluginSource;
}

export interface InstalledPlugin {
  readonly enabled: boolean;
  readonly builtin?: boolean | undefined;
  readonly grants: readonly Permission[];
  readonly storageFile?: string | undefined;
  readonly entry?: string | undefined;
  readonly distribution?: PluginDistribution | undefined;
  readonly previous?: InstalledPlugin | undefined;
}

export interface PluginsManifest {
  readonly schema: typeof PLUGINS_SCHEMA;
  readonly revision: number;
  readonly order: readonly string[];
  readonly plugins: Readonly<Record<string, InstalledPlugin>>;
}

export const BUILTIN_IDS = ['autocorrect', 'shortcuts', 'menu', 'rescue', 'phrases', 'history', 'names'] as const;

/** An installed third-party plugin ready for the isolated executor. */
export interface SelectedPlugin {
  readonly id: string;
  readonly source: string;
  readonly manifest: PluginManifest;
  /** The grants the user reviewed, never more than the manifest declares. */
  readonly grants: readonly Permission[];
  readonly digest: string;
}

export interface PluginSelection {
  readonly revision: number;
  /** Enabled third-party plugins, in plugins.json order. */
  readonly plugins: readonly SelectedPlugin[];
  /** Built-ins turned off with `murmo plugin disable`. */
  readonly disabled: readonly string[];
  readonly order: readonly string[];
  /** One line per plugin that could not load, saying why and what to run. */
  readonly notices: readonly string[];
}

export const EMPTY_SELECTION: PluginSelection = { revision: 0, plugins: [], disabled: [], order: [], notices: [] };

/** Reads a file; `undefined` when it does not exist. */
export type SelectionRead = (path: string) => Promise<Uint8Array | string | undefined>;

const bytesOf = (raw: Uint8Array | string): Uint8Array => (typeof raw === 'string' ? utf8Encode(raw) : raw);
const textOf = (raw: Uint8Array | string): string => (typeof raw === 'string' ? raw : (utf8Decode(raw) ?? ''));
const isBuiltin = (id: string, plugin: InstalledPlugin): boolean =>
  plugin.builtin === true || (BUILTIN_IDS as readonly string[]).includes(id);

/** plugins.json as parsed, or undefined when it is absent or not this schema. */
export function parsePluginsManifest(raw: Uint8Array | string | undefined): PluginsManifest | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(textOf(raw)) as PluginsManifest;
    if (value?.schema !== PLUGINS_SCHEMA || !value.plugins || !Array.isArray(value.order)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

async function loadInstalled(
  roots: Pick<StoreRoots, 'data'>,
  id: string,
  plugin: InstalledPlugin,
  read: SelectionRead,
): Promise<SelectedPlugin | string> {
  const dist = plugin.distribution;
  if (!dist) return `${id} is selected but not installed; run murmo plugin add again`;
  const files = dist.manifest.files as Record<string, string> | undefined;
  const entry = dist.manifest.entry;
  if (!files || typeof entry !== 'string') return `${id} has no signed file list; run murmo plugin update ${id}`;
  const dir = extensionsDir(roots as StoreRoots, id, dist.digest);
  const checked = async (rel: string): Promise<Uint8Array | undefined> => {
    const raw = await read(`${dir}/${rel}`);
    if (raw === undefined) return undefined;
    const bytes = bytesOf(raw);
    return files[rel] === sha256Hex(bytes) ? bytes : undefined;
  };
  const code = await checked(entry);
  const manifestBytes = await checked('murmo.plugin.json');
  if (!code || !manifestBytes) {
    return `${id} was not loaded: its installed files are missing or changed; run murmo plugin reinstall ${id}`;
  }
  const source = utf8Decode(code);
  if (source === null) return `${id} was not loaded: ${entry} is not UTF-8 text`;
  let manifest: PluginManifest;
  try {
    manifest = validateManifest(JSON.parse(textOf(manifestBytes)));
  } catch (error) {
    return `${id} was not loaded: murmo.plugin.json is not valid (${error instanceof Error ? error.message : String(error)})`;
  }
  if (manifest.name !== id || manifest.entry !== entry) {
    return `${id} was not loaded: murmo.plugin.json names ${manifest.name} with entry ${manifest.entry}`;
  }
  const declared = new Set(manifest.permissions.map((p) => p.name));
  return {
    id,
    source,
    manifest,
    grants: plugin.grants.filter((name) => declared.has(name)),
    digest: dist.digest,
  };
}

/**
 * The selection a new session loads. Never throws: a missing plugins.json is
 * an empty selection (setup creates it), and a plugin that cannot load is a
 * notice while the others still load.
 */
export async function readPluginSelection(
  roots: Pick<StoreRoots, 'data'>,
  read: SelectionRead,
): Promise<PluginSelection> {
  let raw: Uint8Array | string | undefined;
  try {
    raw = await read(pluginsManifestPath(roots as StoreRoots));
  } catch {
    raw = undefined;
  }
  const manifest = parsePluginsManifest(raw);
  if (!manifest) return EMPTY_SELECTION;
  const ids = [...manifest.order, ...Object.keys(manifest.plugins).filter((id) => !manifest.order.includes(id))];
  const plugins: SelectedPlugin[] = [];
  const disabled: string[] = [];
  const notices: string[] = [];
  for (const id of ids) {
    const plugin = manifest.plugins[id];
    if (!plugin) continue;
    if (isBuiltin(id, plugin)) {
      if (plugin.enabled === false) disabled.push(id);
      continue;
    }
    if (plugin.enabled === false) continue;
    try {
      const loaded = await loadInstalled(roots, id, plugin, read);
      if (typeof loaded === 'string') notices.push(loaded);
      else plugins.push(loaded);
    } catch (error) {
      notices.push(`${id} was not loaded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { revision: manifest.revision, plugins, disabled, order: ids, notices };
}

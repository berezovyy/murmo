// Durable payload under `$XDG_DATA_HOME/murmo/package` (store layout, phase 14/27).
// Version handshake, then the packed table via `$.fs` bytes. No Node, no timer.

import { parseConfig } from '@murmo/config';
import { mapTable } from '@murmo/lang';
import { bytesOf, textOf } from './decode.ts';
import { type ClaudeRuntime, FS_MAX_BYTES, PLUGIN_VERSION } from './types.ts';

export const TABLE_ASSET = 'english.bin';
/** Packed layout from phase 26. Keep in sync with @murmo/integrity TABLE_FILE. */
const TABLE_PATH = `data/en/${TABLE_ASSET}`;
const CASE_POLICY_PATH = 'data/en/case-policy.json';
const HELPER_DARWIN = 'bin/darwin-arm64/murmo-plugin-host';
const HELPER_LINUX = 'bin/linux-arm64/murmo-plugin-host';

export interface IntegrityFile {
  readonly version: string;
  readonly files?:
    | Readonly<Record<string, string | { readonly sha256: string; readonly bytes?: number }>>
    | readonly { readonly path: string; readonly sha256: string; readonly size?: number }[];
}

export interface PayloadTable {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly entries: number;
  readonly lowercaseOnly: readonly string[];
}

export interface LocatedPayload {
  readonly root: string;
  readonly integrity: IntegrityFile;
  readonly table?: PayloadTable;
  readonly helper?: string;
  readonly notice?: string;
}

function join(base: string, path: string): string {
  if (!base) return path;
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function hashOf(files: IntegrityFile['files'], path: string): string | undefined {
  if (!files) return undefined;
  if (Array.isArray(files)) {
    const entry = files.find((f) => f.path === path);
    return entry?.sha256;
  }
  const entry = (files as Readonly<Record<string, string | { readonly sha256: string }>>)[path];
  if (!entry) return undefined;
  return typeof entry === 'string' ? entry : entry.sha256;
}

export async function dataHome($: ClaudeRuntime): Promise<string> {
  const xdg = await $.env.get('XDG_DATA_HOME');
  if (xdg) return join(xdg, 'murmo');
  const home = (await $.env.get('HOME')) ?? '';
  return join(home, '.local/share/murmo');
}

export async function configHome($: ClaudeRuntime): Promise<string> {
  const xdg = await $.env.get('XDG_CONFIG_HOME');
  if (xdg) return join(xdg, 'murmo');
  const home = (await $.env.get('HOME')) ?? '';
  return join(home, '.config/murmo');
}

async function readJson($: ClaudeRuntime, path: string): Promise<unknown> {
  if (!(await $.fs.exists(path))) return undefined;
  const raw = textOf(await $.fs.read(path));
  if (raw.length > FS_MAX_BYTES) throw new Error(`${path} exceeds the 4 MiB $.fs limit`);
  return JSON.parse(raw) as unknown;
}

function packageFromPluginRoot(pluginRoot: string): string | undefined {
  const markers = ['/adapters/claude/hooks', '/adapters/claude'];
  for (const marker of markers) {
    if (pluginRoot === marker || pluginRoot.endsWith(marker) || pluginRoot.endsWith(`${marker}/`)) {
      const cut = pluginRoot.lastIndexOf('/adapters/claude');
      if (cut > 0) return pluginRoot.slice(0, cut);
    }
  }
  return undefined;
}

export async function locatePayload($: ClaudeRuntime, override?: string): Promise<LocatedPayload | undefined> {
  const candidates: string[] = [];
  if (override) candidates.push(override);
  candidates.push(join(await dataHome($), 'package'));
  const fromPlugin = packageFromPluginRoot($.plugin.root);
  if (fromPlugin && !candidates.includes(fromPlugin)) candidates.push(fromPlugin);
  let lastUnreadable: LocatedPayload | undefined;
  for (const root of candidates) {
    const integrityPath = join(root, 'integrity.json');
    if (!(await $.fs.exists(integrityPath))) continue;
    const integrity = (await readJson($, integrityPath)) as IntegrityFile;
    if (!integrity || typeof integrity.version !== 'string') {
      lastUnreadable = { root, integrity: { version: '' }, notice: 'payload integrity.json is unreadable' };
      continue;
    }
    if (integrity.version !== PLUGIN_VERSION) {
      return {
        root,
        integrity,
        notice: `payload version ${integrity.version} does not match plugin ${PLUGIN_VERSION}`,
      };
    }
    return { root, integrity };
  }
  return lastUnreadable;
}

export async function loadTable($: ClaudeRuntime, payload: LocatedPayload): Promise<PayloadTable | undefined> {
  const path = join(payload.root, TABLE_PATH);
  if (!(await $.fs.exists(path))) return undefined;
  const raw = await $.fs.read(path, { as: 'bytes' });
  const bytes = bytesOf(raw);
  if (bytes.byteLength > FS_MAX_BYTES) return undefined;
  const aligned =
    bytes.byteOffset === 0 && bytes.buffer instanceof ArrayBuffer
      ? bytes
      : (() => {
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          return copy;
        })();
  const mapped = mapTable(aligned);
  const sha256 = hashOf(payload.integrity.files, TABLE_PATH) ?? '';
  let lowercaseOnly: string[] = [];
  const casePath = join(payload.root, CASE_POLICY_PATH);
  if (await $.fs.exists(casePath)) {
    try {
      const json = (await readJson($, casePath)) as { lowercaseOnly?: unknown };
      if (Array.isArray(json.lowercaseOnly)) {
        lowercaseOnly = json.lowercaseOnly.filter((w): w is string => typeof w === 'string');
      }
    } catch {
      lowercaseOnly = [];
    }
  }
  return { bytes: aligned, sha256, entries: mapped.entries, lowercaseOnly };
}

export async function helperPath($: ClaudeRuntime, payload: LocatedPayload): Promise<string | undefined> {
  const darwin = join(payload.root, HELPER_DARWIN);
  const linux = join(payload.root, HELPER_LINUX);
  if (await $.fs.exists(darwin)) return darwin;
  if (await $.fs.exists(linux)) return linux;
  return undefined;
}

export async function readUserConfig($: ClaudeRuntime): Promise<string | undefined> {
  const path = join(await configHome($), 'murmo.toml');
  if (!(await $.fs.exists(path))) return undefined;
  const text = textOf(await $.fs.read(path));
  if (text.length > FS_MAX_BYTES) return undefined;
  return text;
}

export function parseUserConfig(text: string | undefined, file: string) {
  if (text === undefined) return undefined;
  return parseConfig(text, { file, origin: 'user' });
}

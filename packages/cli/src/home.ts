// Host config dirs, owned roots, known files, and HOME inventories.
// OpenCode Bun cache and Codex $CODEX_HOME are roots so session writes
// uninstall (r12 I1 / E6). Detect never walks the target HOME (r10 I1 / E2).

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { userConfigPath } from '@murmo/config/node';
import { storeRootsFromEnv } from '@murmo/store/node';
import { CliError } from './errors.ts';

export type HostName = 'claude' | 'pi' | 'opencode' | 'codex';
export const HOST_NAMES: readonly HostName[] = ['pi', 'opencode', 'claude', 'codex'];

export interface PathMeta {
  readonly type: 'file' | 'dir' | 'link';
  readonly mode: number;
}

export interface HomeLayout {
  readonly home: string;
  readonly data: string;
  readonly state: string;
  readonly cache: string;
  readonly payload: string;
  readonly staging: string;
  readonly generations: string;
  readonly journal: string;
  readonly validated: string;
  readonly sessions: string;
  readonly launcher: string;
  readonly localBin: string;
  /** The personal `murmo.toml`; setup writes the starter one only where none exists. */
  readonly personal: string;
  readonly dirs: {
    readonly claude: string;
    readonly pi: string;
    readonly opencode: string;
    readonly codex: string;
  };
  readonly xdg: { readonly config: string; readonly data: string; readonly cache: string; readonly state: string };
}

function xdg(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value && isAbsolute(value) ? value : fallback;
}

export function homeLayout(env: NodeJS.ProcessEnv = process.env): HomeLayout {
  const home = env.HOME;
  if (!home) {
    throw new CliError('HOME is unset', { action: 'set HOME to the profile Murmo should install into' });
  }
  const roots = storeRootsFromEnv(env, home);
  const xdgDirs = {
    config: xdg(env, 'XDG_CONFIG_HOME', join(home, '.config')),
    data: xdg(env, 'XDG_DATA_HOME', join(home, '.local', 'share')),
    cache: xdg(env, 'XDG_CACHE_HOME', join(home, '.cache')),
    state: xdg(env, 'XDG_STATE_HOME', join(home, '.local', 'state')),
  };
  const dirs = {
    claude: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    pi: env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'),
    opencode: env.OPENCODE_CONFIG_DIR || join(xdgDirs.config, 'opencode'),
    codex: env.CODEX_HOME || join(home, '.codex'),
  };
  return {
    home,
    data: roots.data,
    state: roots.state,
    cache: roots.cache,
    payload: join(roots.data, 'package'),
    staging: join(roots.data, 'staging'),
    generations: join(roots.data, 'generations'),
    journal: join(roots.data, 'install.json'),
    validated: join(roots.data, 'validated.json'),
    sessions: join(roots.data, 'sessions'),
    launcher: join(home, '.local', 'bin', 'murmo'),
    localBin: join(home, '.local', 'bin'),
    personal: userConfigPath(env, home),
    dirs,
    xdg: xdgDirs,
  };
}

/** Directories sessions write into; uninstall deletes anything created under them. */
export function ownedRoots(layout: HomeLayout): string[] {
  return [
    join(layout.xdg.cache, 'bun'),
    layout.dirs.claude,
    layout.dirs.pi,
    layout.dirs.opencode,
    layout.dirs.codex,
    join(layout.xdg.cache, 'opencode'),
    join(layout.xdg.data, 'opencode'),
    join(layout.xdg.state, 'opencode'),
  ];
}

/** Config files we restore byte- and mode-exact. Never histories or transcripts. */
export function knownFiles(layout: HomeLayout): string[] {
  return [
    join(layout.dirs.codex, 'config.toml'),
    join(layout.dirs.codex, 'hooks.json'),
    join(layout.home, '.claude.json'),
    join(layout.dirs.claude, '.claude.json'),
    join(layout.dirs.claude, 'settings.json'),
    join(layout.dirs.claude, 'plugins', 'installed_plugins.json'),
    join(layout.dirs.claude, 'plugins', 'known_marketplaces.json'),
    join(layout.dirs.pi, 'settings.json'),
    join(layout.dirs.opencode, 'cli.json'),
    layout.launcher,
  ];
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function inventoryOf(roots: readonly string[]): Record<string, PathMeta> {
  const out: Record<string, PathMeta> = {};
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    const st = lstatSync(path);
    const type: PathMeta['type'] = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
    out[path] = { type, mode: st.mode & 0o777 };
    if (type === 'dir') {
      for (const name of readdirSync(path)) visit(join(path, name));
    }
  };
  for (const root of roots) visit(root);
  return out;
}

/** Parents of owned roots and the store, keyed by whether they already existed. */
export function parentExistence(layout: HomeLayout, extra: readonly string[] = []): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const seeds = [...ownedRoots(layout), layout.data, layout.state, layout.cache, layout.localBin, ...extra];
  for (const start of seeds) {
    for (let p = start; p !== layout.home && p !== dirname(p); p = dirname(p)) {
      if (out[p] === undefined) out[p] = existsSync(p);
    }
  }
  return out;
}

export function localBinOnPath(layout: HomeLayout, env: NodeJS.ProcessEnv): boolean {
  const want = resolve(layout.localBin);
  for (const part of (env.PATH ?? '').split(':')) {
    if (part && resolve(part) === want) return true;
  }
  return false;
}

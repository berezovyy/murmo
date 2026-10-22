// `murmo names rebuild|wipe|status` and `murmo index`: spawn the idle Rust
// indexer. Not a daemon; a lock file serializes one build per project.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectCache } from '@murmo/store';
import { findRepositoryRoot, projectIdentity } from '@murmo/store/node';
import { displayText } from '@murmo/text';
import { INDEXER_VERSION, NAMES_CURRENT, NAMES_DIR, NAMES_META } from '../packed.ts';
import type { VocabContext } from './vocab.ts';

export interface NamesContext extends VocabContext {
  readonly env?: NodeJS.ProcessEnv;
}

export const NAMES_USAGE = 'usage: murmo names rebuild|wipe|status [<root>]';
export const INDEX_USAGE = 'usage: murmo index [<root>]';

export function indexerBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.MURMO_INDEX && existsSync(env.MURMO_INDEX)) return env.MURMO_INDEX;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    let cargo = '';
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, 'tools/cargo.mjs');
      if (existsSync(candidate)) {
        cargo = candidate;
        break;
      }
      dir = dirname(dir);
    }
    if (!cargo) return undefined;
    const printed = spawnSync(process.execPath, [cargo, '--print-target-dir'], {
      encoding: 'utf8',
    });
    const target = printed.stdout.trim();
    for (const name of ['debug/murmo-index', 'release/murmo-index']) {
      const p = join(target, name);
      if (existsSync(p)) return p;
    }
  } catch {
    // Dev tree without a built indexer.
  }
  return undefined;
}

async function namesDir(context: NamesContext, rootArg?: string): Promise<{ root: string; dir: string }> {
  const start = resolve(context.cwd, rootArg ?? '.');
  const root = (await findRepositoryRoot(start)) ?? start;
  const identity = await projectIdentity(root);
  const cacheDir = projectCache(context.store.layout, identity.projectId);
  return { root, dir: join(cacheDir, NAMES_DIR) };
}

function readMeta(dir: string): {
  records?: number;
  files?: number;
  builtAtMs?: number;
  lastError?: string;
  sources?: Record<string, { records?: number; error?: string }>;
} | null {
  try {
    const current = readFileSync(join(dir, NAMES_CURRENT), 'utf8').trim();
    const raw = JSON.parse(readFileSync(join(dir, current, NAMES_META), 'utf8')) as {
      records?: number;
      files?: number;
      builtAtMs?: number;
      lastError?: string | null;
      sources?: Record<string, { records?: number; error?: string }>;
    };
    return {
      ...(typeof raw.records === 'number' ? { records: raw.records } : {}),
      ...(typeof raw.files === 'number' ? { files: raw.files } : {}),
      ...(typeof raw.builtAtMs === 'number' ? { builtAtMs: raw.builtAtMs } : {}),
      ...(typeof raw.lastError === 'string' ? { lastError: raw.lastError } : {}),
      ...(raw.sources ? { sources: raw.sources } : {}),
    };
  } catch {
    return null;
  }
}

export function namesDoctorLine(cacheDir: string): { ok: boolean; detail: string } {
  const dir = join(cacheDir, NAMES_DIR);
  const meta = readMeta(dir);
  if (!meta) return { ok: true, detail: 'no name index' };
  const ageSec = meta.builtAtMs ? Math.floor((Date.now() - meta.builtAtMs) / 1000) : 0;
  const err = meta.lastError && meta.lastError !== 'none' ? meta.lastError : 'none';
  const lsp = meta.sources?.lsp?.error ? ` lsp=${meta.sources.lsp.error}` : '';
  return {
    ok: err === 'none',
    detail: `records=${meta.records ?? 0} files=${meta.files ?? 0} ageSec=${ageSec} error=${err} indexer=${INDEXER_VERSION}${lsp}`,
  };
}

export async function namesCommand(args: readonly string[], context: NamesContext): Promise<number> {
  const verb = args[0];
  if (verb !== 'rebuild' && verb !== 'wipe' && verb !== 'status' && verb !== undefined) {
    context.err(NAMES_USAGE);
    return 2;
  }
  return runNames(verb ?? 'status', args[1], context);
}

export async function indexCommand(args: readonly string[], context: NamesContext): Promise<number> {
  if (args.length > 1) {
    context.err(INDEX_USAGE);
    return 2;
  }
  return runNames('rebuild', args[0], context);
}

async function runNames(verb: string, rootArg: string | undefined, context: NamesContext): Promise<number> {
  try {
    const { root, dir } = await namesDir(context, rootArg);
    if (verb === 'wipe') {
      rmSync(dir, { recursive: true, force: true });
      context.out(`wiped ${displayText(dir)}`);
      return 0;
    }
    if (verb === 'status') {
      const line = namesDoctorLine(dirname(dir));
      context.out(line.detail);
      return line.ok ? 0 : 1;
    }
    const bin = indexerBin(context.env ?? process.env);
    if (!bin) {
      context.err('murmo names: indexer binary not found (build murmo-index)');
      return 1;
    }
    const extra: string[] = [];
    if (context.env?.MURMO_PRIVATE === '1') extra.push('--private');
    const servers = context.env?.MURMO_LSP_SERVERS;
    if (servers) {
      for (const s of servers.split(',').filter(Boolean)) extra.push('--lsp-server', s);
    }
    const run = spawnSync(
      bin,
      [verb === 'rebuild' ? 'rebuild' : 'build', '--root', root, '--cache', dirname(dir), ...extra],
      { encoding: 'utf8' },
    );
    if (run.stdout) context.out(run.stdout.trimEnd());
    if (run.status !== 0) {
      context.err(run.stderr.trim() || 'murmo names: indexer failed');
      return run.status ?? 1;
    }
    return 0;
  } catch (error) {
    context.err(`murmo names: ${displayText((error as Error).message)}`);
    return 1;
  }
}

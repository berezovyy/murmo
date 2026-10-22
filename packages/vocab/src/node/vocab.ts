// `murmo vocab build <root>`: low-priority child, one build per project under
// a store lock. Reports partial when file/byte limits stop the walk.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { mapTable } from '@murmo/lang';
import { ensurePack, PACK_FILES } from '@murmo/lang-en';
import { projectCache } from '@murmo/store';
import { findRepositoryRoot, projectIdentity, type Store, withLock } from '@murmo/store/node';
import { displayText } from '@murmo/text';
import { NAMES_CURRENT, NAMES_DIR, NAMES_META, PROTECT_FILE } from '../index.ts';
import { buildAndWrite } from './build.ts';

export interface VocabContext {
  readonly store: Store;
  readonly cwd: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const VOCAB_USAGE = 'usage: murmo vocab build|show|wipe [--project] [<root>]';

function lowerPriority(): void {
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    try {
      os.setPriority(10);
    } catch {
      // Best effort: a session still waits on the lock, not on the nice value.
    }
  }
}

async function cacheFor(context: VocabContext, rootArg?: string): Promise<{ root: string; cacheDir: string }> {
  const start = resolve(context.cwd, rootArg ?? '.');
  const root = (await findRepositoryRoot(start)) ?? start;
  const identity = await projectIdentity(root);
  return { root, cacheDir: projectCache(context.store.layout, identity.projectId) };
}

function showIndex(cacheDir: string, out: (text: string) => void): void {
  const dir = join(cacheDir, NAMES_DIR);
  out(`cache ${displayText(dir)}`);
  try {
    const current = readFileSync(join(dir, NAMES_CURRENT), 'utf8').trim();
    const raw = JSON.parse(readFileSync(join(dir, current, NAMES_META), 'utf8')) as {
      records?: number;
      files?: number;
      builtAtMs?: number;
      lastError?: string | null;
      sources?: Record<string, { records?: number; error?: string }>;
      private?: boolean;
    };
    const age = raw.builtAtMs ? Math.floor((Date.now() - raw.builtAtMs) / 1000) : 0;
    out(`records=${raw.records ?? 0} files=${raw.files ?? 0} ageSec=${age} private=${raw.private === true}`);
    for (const [name, info] of Object.entries(raw.sources ?? {})) {
      const err = info.error?.length ? ` error=${info.error}` : '';
      out(`  ${name}: ${info.records ?? 0}${err}`);
    }
    const err = raw.lastError && raw.lastError !== 'none' ? raw.lastError : 'none';
    out(`error=${err}`);
  } catch {
    out('no name index');
  }
}

export async function vocabCommand(args: readonly string[], context: VocabContext): Promise<number> {
  const verb = args[0];
  const rest = args.slice(1).filter((a) => a !== '--project');
  if (verb !== 'build' && verb !== 'show' && verb !== 'wipe') {
    context.err(VOCAB_USAGE);
    return 2;
  }
  try {
    const { root, cacheDir } = await cacheFor(context, rest[0]);
    if (verb === 'show') {
      showIndex(cacheDir, context.out);
      return 0;
    }
    if (verb === 'wipe') {
      const dir = join(cacheDir, NAMES_DIR);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      context.out(`wiped ${displayText(dir)}`);
      return 0;
    }
    lowerPriority();
    const packDir = ensurePack();
    const tableBytes = readFileSync(join(packDir, PACK_FILES.table));
    const copy = new Uint8Array(tableBytes.byteLength);
    copy.set(tableBytes);
    const typo = mapTable(copy);
    const typoHash = createHash('sha256').update(copy).digest('hex');
    const locked = await withLock(join(cacheDir, PROTECT_FILE), async () =>
      buildAndWrite({ root, cacheDir, typo, typoHash }),
    );
    if (locked.status === 'busy') {
      context.err('murmo vocab: another build is running for this project');
      return 1;
    }
    const result = locked.value;
    const line = result.partial
      ? `partial protection table (${result.keys.length} keys, ${result.bytes.byteLength} bytes); file or byte limit reached`
      : `protection table ${result.keys.length} keys, ${result.bytes.byteLength} bytes`;
    context.out(`${line} → ${displayText(result.path)}`);
    return 0;
  } catch (error) {
    context.err(`murmo vocab: ${displayText((error as Error).message)}`);
    return 1;
  }
}

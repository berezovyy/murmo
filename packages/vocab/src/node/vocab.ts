// `murmo vocab build <root>`: low-priority child, one build per project under
// a store lock. Reports partial when file/byte limits stop the walk.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { mapTable } from '@murmo/lang';
import { ensurePack, PACK_FILES } from '@murmo/lang-en';
import { projectCache } from '@murmo/store';
import { findRepositoryRoot, projectIdentity, type Store, withLock } from '@murmo/store/node';
import { displayText } from '@murmo/text';
import { PROTECT_FILE } from '../index.ts';
import { buildAndWrite } from './build.ts';

export interface VocabContext {
  readonly store: Store;
  readonly cwd: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const VOCAB_USAGE = 'usage: murmo vocab build [<root>]';

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

export async function vocabCommand(args: readonly string[], context: VocabContext): Promise<number> {
  if (args[0] !== 'build' || args.length > 2) {
    context.err(VOCAB_USAGE);
    return 2;
  }
  const start = resolve(context.cwd, args[1] ?? '.');
  try {
    lowerPriority();
    const root = (await findRepositoryRoot(start)) ?? start;
    const identity = await projectIdentity(root);
    const cacheDir = projectCache(context.store.layout, identity.projectId);
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

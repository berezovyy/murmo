// `murmo words add|remove|list [--project]`. Phase 27 mounts this; the
// package owns the command.

import { resolve } from 'node:path';
import { findRepositoryRoot, projectIdentity, type Store } from '@murmo/store/node';
import { displayText } from '@murmo/text';

export interface WordsContext {
  readonly store: Store;
  readonly cwd: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const WORDS_USAGE = [
  'usage: murmo words list [--project <dir>] [--json]',
  '       murmo words add <word> [--project <dir>]',
  '       murmo words remove <word> [--project <dir>]',
].join('\n');

const VALUE_FLAGS = new Set(['--project']);
const BARE_FLAGS = new Set(['--json']);

function parse(args: readonly string[]): { positional: string[]; flags: Map<string, string | true> } | string {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
      if (flags.has(arg)) return `${arg} given twice`;
      flags.set(arg, value);
      i++;
    } else if (BARE_FLAGS.has(arg)) {
      flags.set(arg, true);
    } else if (arg.startsWith('--')) {
      return `unknown option ${arg}`;
    } else positional.push(arg);
  }
  return { positional, flags };
}

async function projectOf(dir: string | undefined, cwd: string): Promise<string | undefined> {
  if (dir === undefined) return undefined;
  const start = resolve(cwd, dir);
  const root = (await findRepositoryRoot(start)) ?? start;
  return (await projectIdentity(root)).projectId;
}

export async function wordsCommand(args: readonly string[], context: WordsContext): Promise<number> {
  const parsed = parse(args);
  if (typeof parsed === 'string') {
    context.err(`${parsed}\n${WORDS_USAGE}`);
    return 2;
  }
  const [sub, word, ...rest] = parsed.positional;
  const json = parsed.flags.has('--json');
  const projectFlag = parsed.flags.get('--project');
  try {
    const projectId = await projectOf(typeof projectFlag === 'string' ? projectFlag : undefined, context.cwd);
    if (sub === 'list') {
      if (word !== undefined || rest.length > 0) {
        context.err(WORDS_USAGE);
        return 2;
      }
      const words = await context.store.words.list(projectId);
      context.out(
        json ? JSON.stringify({ words, projectId: projectId ?? null }) : words.length ? words.join('\n') : '',
      );
      return 0;
    }
    if (sub === 'add' || sub === 'remove') {
      if (typeof word !== 'string' || rest.length > 0 || json) {
        context.err(WORDS_USAGE);
        return 2;
      }
      if (sub === 'add') {
        const result = await context.store.words.add(word, { learned: false, ...(projectId ? { projectId } : {}) });
        if (result.status !== 'ok') {
          context.err(`murmo words: ${result.status === 'denied' ? result.reason : 'failed'}`);
          return 1;
        }
        context.out(result.written ? `Added ${displayText(word)}.` : `${displayText(word)} is already on the list.`);
        return 0;
      }
      const result = await context.store.words.remove(word, projectId ? { projectId } : {});
      if (result.status !== 'ok') {
        context.err('murmo words: failed');
        return 1;
      }
      context.out(result.written ? `Removed ${displayText(word)}.` : `${displayText(word)} was not on the list.`);
      return 0;
    }
  } catch (error) {
    context.err(`murmo words: ${displayText((error as Error).message)}`);
    return 1;
  }
  context.err(WORDS_USAGE);
  return 2;
}

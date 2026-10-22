// Mount commands owned by other packages (handoffs 11, 14, 15, 19).
// plugin enable/disable/add/remove is phase 28.

import { createInterface } from 'node:readline';
import { historyCommand } from '@murmo/plugin-history/node';
import { phrasesCommand } from '@murmo/plugin-phrases/node';
import { initCommand, saveCommand, trustCommand } from '@murmo/plugin-shortcuts/node';
import { dataCommand, openStore, privateCommand, storeRootsFromEnv } from '@murmo/store/node';
import { indexCommand, namesCommand, vocabCommand, wordsCommand } from '@murmo/vocab/node';

export interface MountedIO {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** One answer line; '' when input ends first (a review then approves nothing). */
  readonly ask: (prompt: string) => Promise<string>;
}

/** Reads one answer from stdin, a terminal or a pipe (`echo y | murmo trust`). */
export function askStdin(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  return new Promise<string>((resolve) => {
    let answered = false;
    rl.once('close', () => {
      if (!answered) resolve('');
    });
    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

export async function dispatchMounted(
  cmd: string,
  rest: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  io: MountedIO,
): Promise<number> {
  if (cmd === 'plugin') {
    const { pluginCommand } = await import('@murmo/devkit');
    return pluginCommand(['plugin', ...rest]);
  }

  const store = await openStore({ roots: storeRootsFromEnv(env, env.HOME) });
  const ctx = {
    store,
    cwd,
    out: io.out,
    err: io.err,
    ask: io.ask,
    env,
    ...(env.HOME ? { home: env.HOME } : {}),
  };
  if (cmd === 'trust') return trustCommand(rest, ctx);
  if (cmd === 'init') return initCommand(rest, ctx);
  if (cmd === 'shortcuts') {
    const [sub, ...args] = rest;
    if (sub === 'save') return saveCommand(args, ctx);
    ctx.err('usage: murmo shortcuts save [--name NAME] [--text TEXT] [--yes]');
    return 2;
  }
  if (cmd === 'vocab') return vocabCommand(rest, ctx);
  if (cmd === 'words') return wordsCommand(rest, ctx);
  if (cmd === 'names') return namesCommand(rest, ctx);
  if (cmd === 'index') return indexCommand(rest, ctx);
  if (cmd === 'data') return dataCommand(rest, ctx);
  if (cmd === 'private') return privateCommand(rest, ctx);
  if (cmd === 'phrases') return phrasesCommand(rest, ctx);
  if (cmd === 'history') return historyCommand(rest, ctx);
  return 2;
}

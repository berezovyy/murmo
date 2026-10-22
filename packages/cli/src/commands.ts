// Mount commands owned by other packages (handoffs 11, 14, 15, 19).
// plugin enable/disable/add/remove is phase 28.

import { historyCommand } from '@murmo/plugin-history/node';
import { phrasesCommand } from '@murmo/plugin-phrases/node';
import { initCommand, trustCommand } from '@murmo/plugin-shortcuts/node';
import { dataCommand, openStore, privateCommand, storeRootsFromEnv } from '@murmo/store/node';
import { indexCommand, namesCommand, vocabCommand, wordsCommand } from '@murmo/vocab/node';

export async function dispatchMounted(
  cmd: string,
  rest: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  _err: (text: string) => void = (text) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
): Promise<number> {
  if (cmd === 'plugin') {
    const { pluginCommand } = await import('@murmo/devkit');
    return pluginCommand(['plugin', ...rest]);
  }

  const store = await openStore({ roots: storeRootsFromEnv(env, env.HOME) });
  const ctx = {
    store,
    cwd,
    out: (text: string) => {
      process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    },
    err: (text: string) => {
      process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
    },
    env,
    ...(env.HOME ? { home: env.HOME } : {}),
  };
  if (cmd === 'trust') return trustCommand(rest, ctx);
  if (cmd === 'init') return initCommand(rest, ctx);
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

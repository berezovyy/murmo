#!/usr/bin/env node
import { pluginDev } from './plugin-dev.ts';
import { pluginNew } from './plugin-new.ts';
import { PROFILES, pluginTest } from './plugin-test.ts';

const usage =
  'murmo plugin new <name> | test [directory] [--profile fake|claude|codex|opencode|pi] [--executor in-process|quickjs|helper|all] | dev [directory] [--profile HOST]';

export async function pluginCommand(argv: string[]): Promise<number> {
  const [noun, verb, ...rest] = argv;
  try {
    if (noun !== 'plugin' || !['new', 'test', 'dev'].includes(verb ?? '')) throw new Error(usage);
    if (verb === 'new') {
      if (rest.length !== 1) throw new Error(usage);
      const directory = await pluginNew(rest[0] as string);
      console.log(JSON.stringify({ command: 'new', directory }));
      return 0;
    }
    let directory = '.';
    let profile = 'fake';
    let executor = 'all';
    let seenDir = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === '--profile') {
        profile = rest[++i] as string;
        if (!(PROFILES as readonly string[]).includes(profile)) throw new Error('invalid --profile');
      } else if (arg === '--executor') {
        executor = rest[++i] as string;
      } else if (arg.startsWith('-') || seenDir) throw new Error(usage);
      else {
        directory = arg;
        seenDir = true;
      }
    }
    if (verb === 'test') {
      console.log(JSON.stringify(await pluginTest(directory, { profile: profile as never, executor }), null, 2));
      return 0;
    }
    await pluginDev(directory, { profile: profile as never });
    return 0;
  } catch (error) {
    console.error(`murmo: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export { pluginDev, pluginNew, pluginTest };

const invoked = process.argv[1]?.includes('cli.ts') || process.argv[1]?.includes('murmo-plugin');
if (invoked) {
  void pluginCommand(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

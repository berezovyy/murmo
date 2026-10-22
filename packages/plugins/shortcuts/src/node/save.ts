// `murmo shortcuts save`: print a TOML snippet and, on an explicit `y`, append
// it to the personal murmo.toml. Never writes a project file (phase 37).

import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { userConfigPath } from '@murmo/config/node';
import { displayText } from '@murmo/text';
import type { TrustContext } from './trust.ts';

export const SAVE_USAGE = 'usage: murmo shortcuts save [--name NAME] [--text TEXT] [--yes]';

const VALUE_FLAGS = new Set(['--name', '--text']);
const BARE_FLAGS = new Set(['--yes']);

function parse(args: readonly string[]): { flags: Map<string, string | true> } | string {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
      if (flags.has(arg)) return `${arg} given twice`;
      flags.set(arg, value);
      i++;
    } else if (BARE_FLAGS.has(arg)) flags.set(arg, true);
    else if (arg.startsWith('--')) return `unknown option ${arg}`;
    else return SAVE_USAGE;
  }
  return { flags };
}

function suggestName(text: string): string {
  const word = /\p{L}+/u.exec(text)?.[0]?.toLowerCase() ?? 'phrase';
  const cut = word.slice(0, 12);
  return `;${cut}`;
}

function tomlBlock(name: string, text: string): string {
  const key = name.startsWith(';') ? `";${name.slice(1)}"` : `"${name}"`;
  if (text.includes('\n')) {
    const body = text.replace(/\n$/, '');
    return `[replace]\n${key} = '''\n${body}\n'''\n`;
  }
  const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `[replace]\n${key} = '${escaped}'\n`;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    await stat(path);
  } catch {
    return null;
  }
  return readFile(path, 'utf8');
}

/** Exclusive-create temp, check the personal file is unchanged, rename. */
export async function appendPersonal(path: string, previous: string | null, block: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const current = await readIfPresent(path);
  if ((current ?? null) !== previous) throw new Error('personal file changed on disk; not written');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(tmp, 'wx', 0o600);
  try {
    const body = `${current ?? 'version = 1\n'}${current && !current.endsWith('\n') ? '\n' : ''}${block}`;
    await handle.writeFile(body, 'utf8');
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

export async function saveCommand(args: readonly string[], context: TrustContext): Promise<number> {
  const parsed = parse(args);
  if (typeof parsed === 'string') {
    context.err(`${parsed}\n${SAVE_USAGE}`);
    return 2;
  }
  const textFlag = parsed.flags.get('--text');
  const nameFlag = parsed.flags.get('--name');
  const yes = parsed.flags.has('--yes');
  const text = typeof textFlag === 'string' ? textFlag : '';
  if (!text) {
    context.err(`nothing to save; pass --text\n${SAVE_USAGE}`);
    return 2;
  }
  const name = typeof nameFlag === 'string' && nameFlag ? nameFlag : suggestName(text);
  const block = tomlBlock(name, text);
  context.out(block.trimEnd());
  const path = userConfigPath(context.env ?? process.env, context.home);
  if (!yes) {
    const answer = context.ask ? await context.ask('Append to personal murmo.toml? [y/N] ') : '';
    if (answer.trim().toLowerCase() !== 'y') {
      context.out('Not written.');
      return 0;
    }
  }
  try {
    const previous = await readIfPresent(path);
    await appendPersonal(path, previous, block);
    context.out(`Wrote ${displayText(path)}.`);
    return 0;
  } catch (error) {
    context.err(`murmo shortcuts save: ${displayText((error as Error).message)}`);
    return 1;
  }
}

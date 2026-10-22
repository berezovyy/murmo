// `murmo history list|forget|wipe`. Delete rewrites segments and rebuilds the
// packed snapshot so a grep of the data dir finds 0 copies (E14).

import { resolve } from 'node:path';
import { findRepositoryRoot, projectIdentity, type Store } from '@murmo/store/node';
import { displayText } from '@murmo/text';
import { promptId } from '../memory.ts';
import { doctorLine } from '../plugin.ts';
import { forgetPrompt, lastMerge, loadRecords, readMetrics, wipeHistory } from './store.ts';

export interface HistoryContext {
  readonly store: Store;
  readonly cwd: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const HISTORY_USAGE = [
  'usage: murmo history list [--project <dir>] [--json]',
  '       murmo history forget <id>',
  '       murmo history wipe (--all | --project <dir>)',
].join('\n');

interface Parsed {
  readonly positional: string[];
  readonly flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['--project']);
const BARE_FLAGS = new Set(['--json', '--all']);

function parse(args: readonly string[]): Parsed | string {
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
    } else if (BARE_FLAGS.has(arg)) flags.set(arg, true);
    else if (arg.startsWith('--')) return `unknown option ${arg}`;
    else positional.push(arg);
  }
  return { positional, flags };
}

async function projectOf(dir: string, cwd: string): Promise<string> {
  const start = resolve(cwd, dir);
  const root = (await findRepositoryRoot(start)) ?? start;
  return (await projectIdentity(root)).projectId;
}

export async function historyCommand(args: readonly string[], context: HistoryContext): Promise<number> {
  const parsed = parse(args);
  if (typeof parsed === 'string') {
    context.err(`${parsed}\n${HISTORY_USAGE}`);
    return 2;
  }
  const [sub, ...rest] = parsed.positional;
  const json = parsed.flags.has('--json');
  try {
    if (sub === 'list') {
      if (rest.length > 0) {
        context.err(HISTORY_USAGE);
        return 2;
      }
      const projectFlag = parsed.flags.get('--project');
      const project = typeof projectFlag === 'string' ? await projectOf(projectFlag, context.cwd) : undefined;
      const rows = (await loadRecords(context.store)).filter(
        (r) => project === undefined || r.events.some((e) => e.project === project),
      );
      if (json) {
        context.out(
          JSON.stringify({
            prompts: rows.map((r) => ({ id: promptId(r.text), count: r.count, lastAt: r.lastAt, text: r.text })),
          }),
        );
        return 0;
      }
      if (rows.length === 0) {
        context.out('No saved prompts.');
        return 0;
      }
      for (const row of rows) {
        const line = row.text.split('\n')[0] ?? row.text;
        context.out(`${promptId(row.text)}  ${row.count}  ${displayText(line)}`);
      }
      return 0;
    }
    if (sub === 'forget') {
      const id = rest[0];
      if (!id || rest.length !== 1) {
        context.err(HISTORY_USAGE);
        return 2;
      }
      const result = await forgetPrompt(context.store, id);
      if (result.removed === 0) {
        context.err(`murmo history: no prompt ${displayText(id)}`);
        return 1;
      }
      context.out(json ? JSON.stringify(result) : `Forgot ${result.removed} entries.`);
      return 0;
    }
    if (sub === 'wipe') {
      if (rest.length > 0) {
        context.err(HISTORY_USAGE);
        return 2;
      }
      const all = parsed.flags.has('--all');
      const projectFlag = parsed.flags.get('--project');
      if (all === (typeof projectFlag === 'string')) {
        context.err(`choose exactly one of --all, --project\n${HISTORY_USAGE}`);
        return 2;
      }
      const project = typeof projectFlag === 'string' ? await projectOf(projectFlag, context.cwd) : undefined;
      const result = await wipeHistory(context.store, project);
      context.out(json ? JSON.stringify(result) : `Wiped ${result.removed} entries.`);
      return 0;
    }
    if (sub === 'stats') {
      const metrics = await readMetrics(context.store);
      const records = await loadRecords(context.store);
      const merged = await lastMerge(context.store);
      context.out(
        json
          ? JSON.stringify({ metrics, prompts: records.length, merged })
          : doctorLine(metrics, {
              prompts: records.length,
              ...(merged ? { merged: String(merged.generation) } : {}),
            }),
      );
      return 0;
    }
  } catch (error) {
    context.err(`murmo history: ${displayText((error as Error).message)}`);
    return 1;
  }
  context.err(HISTORY_USAGE);
  return 2;
}

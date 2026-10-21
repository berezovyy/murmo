// `murmo data show|delete` and `murmo private on|off|status`. The `murmo`
// binary and its shared argument and output conventions belong to
// packages/cli (phases 11, 15, 27); these functions are the commands it mounts.
// Exit codes: 0 done, 1 failed, 2 usage.
import { resolve } from 'node:path';
import { DATA_KINDS, type DataKind, type DeleteSelector, type InventoryRow } from './data.ts';
import { findRepositoryRoot, projectIdentity } from './paths.ts';
import type { Store } from './store.ts';

export interface CommandContext {
  readonly store: Store;
  readonly cwd: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const DATA_USAGE = [
  'usage: murmo data show [--project <dir>] [--json]',
  '       murmo data delete (--all | --project <dir> | --kind <words|plugins|drafts|trust|vocab|logs> | --word <word>) [--json]',
].join('\n');

export const PRIVATE_USAGE = 'usage: murmo private (on | off | status) [--json]';

/** Paths and names can hold control characters; show them escaped (r12 K3 policy). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const ESCAPED = /[\u0000-\u001f\u007f-\u009f\u{202a}-\u{202e}\u{2066}-\u{2069}]|[\ud800-\udfff]/gu;

function shown(text: string): string {
  return text.replace(ESCAPED, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

interface Parsed {
  readonly positional: string[];
  readonly flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['--project', '--kind', '--word']);
const BARE_FLAGS = new Set(['--all', '--json']);

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
    } else if (BARE_FLAGS.has(arg)) {
      flags.set(arg, true);
    } else if (arg.startsWith('--')) {
      return `unknown option ${arg}`;
    } else positional.push(arg);
  }
  return { positional, flags };
}

async function projectOf(dir: string, cwd: string): Promise<string> {
  const start = resolve(cwd, dir);
  const root = (await findRepositoryRoot(start)) ?? start;
  return (await projectIdentity(root)).projectId;
}

function table(rows: readonly InventoryRow[]): string {
  if (rows.length === 0) return 'Murmo has no data on disk.';
  const lines = rows.map((r) => [
    r.kind,
    r.scope === 'project' ? `project ${(r.projectId ?? '').slice(0, 12)}` : 'global',
    r.label ?? '',
    r.entries === undefined ? '' : String(r.entries),
    String(r.bytes),
    shown(r.path),
  ]);
  const header = ['kind', 'scope', 'name', 'entries', 'bytes', 'path'];
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => (l[i] as string).length)));
  const format = (cells: readonly string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] as number)))
      .join('  ')
      .trimEnd();
  return [format(header), ...lines.map(format)].join('\n');
}

export async function dataCommand(args: readonly string[], context: CommandContext): Promise<number> {
  const parsed = parse(args);
  if (typeof parsed === 'string') {
    context.err(`${parsed}\n${DATA_USAGE}`);
    return 2;
  }
  const [sub, ...rest] = parsed.positional;
  const json = parsed.flags.has('--json');
  if (rest.length > 0) {
    context.err(DATA_USAGE);
    return 2;
  }
  try {
    if (sub === 'show') {
      if ([...parsed.flags.keys()].some((flag) => flag !== '--project' && flag !== '--json')) {
        context.err(DATA_USAGE);
        return 2;
      }
      const project = parsed.flags.get('--project');
      const rows = await context.store.inventory(
        typeof project === 'string' ? await projectOf(project, context.cwd) : undefined,
      );
      context.out(json ? JSON.stringify({ rows }) : table(rows));
      return 0;
    }
    if (sub === 'delete') {
      const chosen = ['--all', '--project', '--kind', '--word'].filter((f) => parsed.flags.has(f));
      if (chosen.length !== 1) {
        context.err(`choose exactly one of --all, --project, --kind, --word\n${DATA_USAGE}`);
        return 2;
      }
      let selector: DeleteSelector;
      const value = parsed.flags.get(chosen[0] as string);
      switch (chosen[0]) {
        case '--all':
          selector = { all: true };
          break;
        case '--project':
          selector = { projectId: await projectOf(value as string, context.cwd) };
          break;
        case '--kind':
          if (!(DATA_KINDS as readonly string[]).includes(value as string)) {
            context.err(`unknown kind ${shown(String(value))}\n${DATA_USAGE}`);
            return 2;
          }
          selector = { kind: value as DataKind };
          break;
        default:
          selector = { word: value as string };
      }
      const report = await context.store.delete(selector);
      context.out(
        json
          ? JSON.stringify(report)
          : `Deleted ${report.removedFiles} files and ${report.removedEntries} entries; rewrote ${report.rewrittenFiles} files. Open sessions drop the deleted data at their next idle check.`,
      );
      return 0;
    }
  } catch (error) {
    context.err(`murmo data: ${shown((error as Error).message)}`);
    return 1;
  }
  context.err(DATA_USAGE);
  return 2;
}

export async function privateCommand(args: readonly string[], context: CommandContext): Promise<number> {
  const parsed = parse(args);
  const sub = typeof parsed === 'string' ? undefined : parsed.positional[0];
  if (
    typeof parsed === 'string' ||
    parsed.positional.length !== 1 ||
    !['on', 'off', 'status'].includes(sub as string) ||
    [...parsed.flags.keys()].some((f) => f !== '--json')
  ) {
    context.err(PRIVATE_USAGE);
    return 2;
  }
  const json = parsed.flags.has('--json');
  try {
    if (sub !== 'status') await context.store.privacy.setFlag(sub === 'on');
    const flag = await context.store.privacy.flag();
    const effective = await context.store.privacy.isPrivate();
    context.out(
      json
        ? JSON.stringify({ flag, private: effective })
        : effective
          ? `Private mode is on${flag ? '' : ' (set by [privacy] private = true in murmo.toml)'}: Murmo learns nothing and saves no drafts.`
          : 'Private mode is off.',
    );
    return 0;
  } catch (error) {
    context.err(`murmo private: ${shown((error as Error).message)}`);
    return 1;
  }
}

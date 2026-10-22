import { fail } from './errors.ts';

export interface PluginFlags {
  readonly positional: string[];
  readonly flags: Map<string, string | true>;
}

const VALUE = new Set(['--trust-key', '--grant', '--digest', '--registry', '--approve-project', '--timeout']);
const BARE = new Set(['--json', '--offline']);

export function parsePluginArgs(args: readonly string[]): PluginFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (VALUE.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) fail('unknown-argument', { arg });
      if (flags.has(arg)) fail('unknown-argument', { arg, reason: 'duplicate' });
      flags.set(arg, value);
      i++;
    } else if (BARE.has(arg)) {
      flags.set(arg, true);
    } else if (arg.startsWith('--')) {
      fail('unknown-argument', { arg });
    } else positional.push(arg);
  }
  return { positional, flags };
}

export function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

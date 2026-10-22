import { collisionKind, lexiconFromSets, parseTemplate } from '@murmo/plugin-shortcuts';
import type { PureEntry } from '../pure.ts';

interface CollisionInput {
  readonly shortcuts: readonly { readonly shortcut: string; readonly group: string }[];
  readonly words?: readonly string[];
  readonly names?: readonly string[];
  readonly typos?: readonly string[];
}

function collisions(input: unknown): unknown {
  const value = input as CollisionInput;
  const lexicon = lexiconFromSets({ words: value.words, names: value.names, typos: value.typos });
  let bareWarned = 0;
  let prefixedWarned = 0;
  for (const row of value.shortcuts) {
    if (collisionKind(row.shortcut, lexicon) === null) continue;
    if (row.group === 'prefixed') prefixedWarned++;
    else bareWarned++;
  }
  return { bareWarned, prefixedWarned };
}

function parse(input: unknown): unknown {
  const value = input as { source: string; defaults?: Record<string, string> };
  const parsed = parseTemplate(value.source, value.defaults ?? {});
  return { expansion: parsed.expansion, names: [...parsed.names] };
}

export const shortcutsFunctions: Readonly<Record<string, PureEntry>> = {
  'shortcuts.collisions': collisions,
  'templates.parse': parse,
};

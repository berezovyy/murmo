// Read-only shortcut list for the `;` menu (phase 16). Name, first line,
// source and size; no lookup on this path.

import { utf8Length } from '@murmo/text';
import type { CompiledShortcuts, ShortcutSource } from './compile.ts';

export interface ShortcutListItem {
  readonly name: string;
  readonly firstLine: string;
  readonly source: ShortcutSource;
  readonly bytes: number;
  readonly description?: string;
  readonly aliases: readonly string[];
  readonly fields: readonly string[];
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function item(name: string, text: string, compiled: CompiledShortcuts): ShortcutListItem {
  const template = compiled.templates[name];
  const description = compiled.descriptions[name];
  return {
    name,
    firstLine: firstLine(text),
    source: compiled.sources[name] ?? 'personal',
    bytes: utf8Length(text),
    ...(description === undefined ? {} : { description }),
    aliases: compiled.aliasesOf[name] ?? template?.aliases ?? [],
    fields: template?.names ?? [],
  };
}

/** Every compiled shortcut, inline and long, including Claude's menu-only oversized entries. */
export function listShortcuts(compiled: CompiledShortcuts): readonly ShortcutListItem[] {
  const out: ShortcutListItem[] = [];
  const seen = new Set<string>();
  const aliasNames = new Set<string>();
  for (const aliases of Object.values(compiled.aliasesOf)) for (const a of aliases) aliasNames.add(a);
  for (const [name, text] of Object.entries(compiled.inline.entries)) {
    if (aliasNames.has(name)) continue;
    seen.add(name);
    out.push(item(name, text, compiled));
  }
  for (const [name, text] of Object.entries(compiled.long)) {
    if (seen.has(name) || aliasNames.has(name)) continue;
    out.push(item(name, text, compiled));
  }
  return out;
}

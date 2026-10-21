// Read-only shortcut list for the `;` menu (phase 16). Name, first line,
// source and size; no lookup on this path.

import { utf8Length } from '@murmo/text';
import type { CompiledShortcuts, ShortcutSource } from './compile.ts';

export interface ShortcutListItem {
  readonly name: string;
  readonly firstLine: string;
  readonly source: ShortcutSource;
  readonly bytes: number;
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function item(name: string, text: string, source: ShortcutSource): ShortcutListItem {
  return { name, firstLine: firstLine(text), source, bytes: utf8Length(text) };
}

/** Every compiled shortcut, inline and long, including Claude's menu-only oversized entries. */
export function listShortcuts(compiled: CompiledShortcuts): readonly ShortcutListItem[] {
  const out: ShortcutListItem[] = [];
  const seen = new Set<string>();
  for (const [name, text] of Object.entries(compiled.inline.entries)) {
    seen.add(name);
    out.push(item(name, text, compiled.sources[name] ?? 'personal'));
  }
  for (const [name, text] of Object.entries(compiled.long)) {
    if (seen.has(name)) continue;
    out.push(item(name, text, compiled.sources[name] ?? 'personal'));
  }
  return out;
}

import {
  compileShortcuts,
  defaultCellMeasure,
  filterNames,
  formatRow,
  packNames,
  r9MenuShortcuts,
  rankTemplates,
} from '@murmo/plugin-shortcuts';
import type { PureEntry } from '../pure.ts';

interface RankShortcut {
  readonly name: string;
  readonly text?: string;
  readonly firstLine?: string;
  readonly source?: 'personal' | 'project';
}

interface RankInput {
  readonly shortcuts: readonly RankShortcut[];
  readonly query: string;
  readonly overrides?: readonly string[];
  readonly limit?: number;
}

function rank(input: unknown): unknown {
  const value = input as RankInput;
  const compiled = compileShortcuts({
    replacements: value.shortcuts.map((row) => ({
      shortcut: row.name,
      text: row.text ?? row.firstLine ?? row.name,
      origin: row.source === 'project' ? 'project' : 'user',
    })),
    overrides: value.overrides ?? [],
  });
  const table = packNames(compiled, value.overrides ?? []);
  return filterNames(table, value.query, value.limit).map((row) => row.entry.name);
}

interface RowInput {
  readonly name: string;
  readonly firstLine: string;
  readonly source?: 'personal' | 'project';
  readonly override?: boolean;
  readonly width: number;
}

function format(input: unknown): unknown {
  const value = input as RowInput;
  const compiled = compileShortcuts({
    replacements: [
      { shortcut: value.name, text: value.firstLine, origin: value.source === 'project' ? 'project' : 'user' },
    ],
  });
  const table = packNames(compiled, value.override ? [value.name] : []);
  const entry = table.entries[0];
  if (!entry) return { over: true };
  const row = formatRow(entry, value.width, defaultCellMeasure);
  const cells = defaultCellMeasure(row);
  return { over: cells > value.width };
}

function r9Count(input: unknown): unknown {
  const fixture = (input as { fixture: Readonly<Record<string, string>> }).fixture;
  return Object.keys(r9MenuShortcuts(fixture)).length;
}

interface TemplateRankShortcut {
  readonly name: string;
  readonly text?: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly source?: 'personal' | 'project';
}

function rankTemplate(input: unknown): unknown {
  const value = input as {
    readonly shortcuts: readonly TemplateRankShortcut[];
    readonly query: string;
    readonly limit?: number;
  };
  const compiled = compileShortcuts({
    replacements: value.shortcuts.map((row) => ({
      shortcut: row.name,
      text: row.text ?? row.description ?? row.name,
      origin: row.source === 'project' ? 'project' : 'user',
      ...(row.description ? { description: row.description } : {}),
      ...(row.aliases ? { aliases: row.aliases } : {}),
    })),
  });
  return rankTemplates(packNames(compiled), value.query, value.limit).map((row) => row.entry.name);
}

export const menuFunctions: Readonly<Record<string, PureEntry>> = {
  'menu.rank': rank,
  'menu.formatRow': format,
  'menu.r9Count': r9Count,
  'menu.rankTemplates': rankTemplate,
};

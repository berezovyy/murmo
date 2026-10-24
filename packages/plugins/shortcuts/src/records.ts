// The one path from merged config, or from plugin settings, to the records
// `compileShortcuts` takes. Records go through whole, so a template's field
// defaults, description and aliases reach the inline table and the menu on
// every host: per-host copies of `{ shortcut, text, origin }` once dropped
// them, and `;review` inserted `Review <change>` instead of its default.

import type { EffectiveConfig } from '@murmo/config';
import { type CompiledShortcuts, type CompileInput, type CompileShortcut, compileShortcuts } from './compile.ts';

export type ConfigShortcuts = Pick<EffectiveConfig, 'replacements' | 'overrides'>;

/** Compile a host session's merged shortcuts. Every adapter builds its shortcuts and menu from this. */
export function compileConfigShortcuts(
  config: ConfigShortcuts,
  options: Omit<CompileInput, 'replacements' | 'overrides'> = {},
): CompiledShortcuts {
  return compileShortcuts({ ...options, replacements: config.replacements, overrides: config.overrides });
}

type Fields = NonNullable<CompileShortcut['fields']>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fieldsOf(value: unknown): Fields | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, { default?: string }> = Object.create(null);
  for (const [name, spec] of Object.entries(value)) {
    out[name] = isRecord(spec) && typeof spec.default === 'string' ? { default: spec.default } : {};
  }
  return out;
}

/**
 * Records from a `replacements` setting: `name → text`, or `name → { text,
 * description?, aliases?, fields? }` as a `[replace.<name>]` table reads.
 * Entries without a string text are left out; every record is personal.
 */
export function shortcutRecords(value: unknown): CompileShortcut[] {
  if (!isRecord(value)) return [];
  const out: CompileShortcut[] = [];
  const origin = 'user';
  for (const [shortcut, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      out.push({ shortcut, text: entry, origin });
      continue;
    }
    if (!isRecord(entry) || typeof entry.text !== 'string') continue;
    const aliases = Array.isArray(entry.aliases) ? entry.aliases.filter((a): a is string => typeof a === 'string') : [];
    const fields = fieldsOf(entry.fields);
    out.push({
      shortcut,
      text: entry.text,
      origin,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      ...(aliases.length ? { aliases } : {}),
      ...(fields ? { fields } : {}),
    });
  }
  return out;
}

// The one path from merged config, or from plugin settings, to the records
// `compileShortcuts` takes. Records go through whole, so a template's field
// defaults, description and aliases reach the inline table and the menu on
// every host: per-host copies of `{ shortcut, text, origin }` once dropped
// them, and `;review` inserted `Review <change>` instead of its default.

import { configProblemNotices, type EffectiveConfig, type LoadedSession, sessionHint } from '@murmo/config';
import {
  type CompiledShortcuts,
  type CompileInput,
  type CompileShortcut,
  compileShortcuts,
  type NoticeKind,
} from './compile.ts';

export type ConfigShortcuts = Pick<EffectiveConfig, 'replacements' | 'overrides'> &
  Partial<Pick<EffectiveConfig, 'diagnostics'>>;

export interface ConfigCompileOptions
  extends Omit<CompileInput, 'replacements' | 'overrides' | 'trust' | 'projectFile' | 'projectShortcutCount'> {
  /** The session's project trust: an unreviewed project file gets the "murmo trust" notice. */
  readonly session?: Pick<LoadedSession, 'trust' | 'project'>;
}

/**
 * Compile a host session's merged shortcuts. Every adapter builds its
 * shortcuts, menu and shortcut notices from this, with the session's real
 * trust state: Pi and OpenCode once passed none, so an unreviewed project file
 * just left its shortcuts literal and nothing said why.
 */
export function compileConfigShortcuts(config: ConfigShortcuts, options: ConfigCompileOptions = {}): CompiledShortcuts {
  const { session, ...rest } = options;
  const project = session?.project;
  return compileShortcuts({
    ...rest,
    replacements: config.replacements,
    overrides: config.overrides,
    ...(config.diagnostics && rest.diagnostics === undefined ? { diagnostics: config.diagnostics } : {}),
    ...(session ? { trust: session.trust } : {}),
    ...(project ? { projectFile: project.file, projectShortcutCount: project.shortcuts } : {}),
  });
}

/**
 * Everything a host says when a session starts, most important first, for
 * the core's startup notices: project trust, config problems with file and
 * line, skipped shortcuts and overrides, and last the line that says Murmo is
 * on and what it loaded. One list for every host, so each says the same.
 * `hint: false` leaves that last line out, for a host whose own notice says
 * shortcuts and autocorrect are off there (OpenCode without measureText).
 */
export function sessionNotices(
  session: Pick<LoadedSession, 'effective' | 'project'>,
  compiled: CompiledShortcuts,
  options: { readonly hint?: boolean } = {},
): string[] {
  const shortcut = (kind: NoticeKind) => compiled.notices.filter((n) => n.kind === kind).map((n) => n.text);
  return [
    ...shortcut('trust'),
    ...configProblemNotices(session.effective.diagnostics),
    ...(['skipped', 'alias', 'claude-size', 'collision', 'override'] as const).flatMap(shortcut),
    ...(options.hint === false ? [] : [sessionHint(session)]),
  ];
}

/**
 * The short forms of `sessionNotices` rows that have one, by their full text,
 * for a status row too narrow for the full notice (Claude Code beside its
 * mode label and effort pill).
 */
export function noticeShortForms(compiled: CompiledShortcuts): Readonly<Record<string, string>> {
  const out: Record<string, string> = Object.create(null);
  for (const notice of compiled.notices) if (notice.short) out[notice.text] = notice.short;
  return out;
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

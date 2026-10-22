// Compile merged config into the inline literal table, the long-expansion
// list, sources, and one-line notices. No matching happens here: the core
// interpreter expands from the registered data (docs/plan/15).

import { displayText, utf8Length } from '@murmo/text';
import { type CollisionKind, type CollisionLexicon, collisionKind, collisionNotice } from './collisions.ts';
import { defaultsOf, type ParsedTemplate, parseTemplate } from './fields.ts';

export const INLINE_MAX_BYTES = 1024;
export const MAX_INSERT_BYTES = 16_384;
export const SHORTCUTS_ID = 'shortcuts';
export const SHORTCUTS_VERSION = '1.0.0';
/** Lower than the autocorrect table (100) so a typed shortcut that is also a typo key expands. */
export const SHORTCUTS_PRIORITY = 0;

export type ShortcutSource = 'personal' | 'project';

export type NoticeKind = 'trust' | 'override' | 'collision' | 'skipped' | 'claude-size' | 'alias';

export interface ShortcutNotice {
  readonly kind: NoticeKind;
  readonly text: string;
}

export interface CompiledTemplate {
  readonly names: readonly string[];
  readonly fields: ParsedTemplate['fields'];
  readonly firstField: number | null;
  readonly description?: string;
  readonly aliases: readonly string[];
}

export interface CompiledShortcuts {
  readonly inline: {
    readonly format: 'literal-utf8-v1';
    readonly entries: Readonly<Record<string, string>>;
    readonly cursors: Readonly<Record<string, number>>;
  };
  readonly long: Readonly<Record<string, string>>;
  readonly sources: Readonly<Record<string, ShortcutSource>>;
  readonly templates: Readonly<Record<string, CompiledTemplate>>;
  readonly descriptions: Readonly<Record<string, string>>;
  readonly aliasesOf: Readonly<Record<string, readonly string[]>>;
  readonly fingerprint: string | null;
  readonly notices: readonly ShortcutNotice[];
}

export interface CompileShortcut {
  readonly shortcut: string;
  readonly text: string;
  readonly origin: 'user' | 'project';
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly fields?: Readonly<Record<string, { readonly default?: string }>>;
}

export interface CompileDiagnostic {
  readonly code: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface CompileInput {
  readonly replacements: readonly CompileShortcut[];
  readonly overrides?: readonly string[];
  readonly diagnostics?: readonly CompileDiagnostic[];
  readonly trust?: 'approved' | 'review' | 'changed' | 'not-approvable' | 'none';
  readonly fingerprint?: string | null;
  /** Display path of the project file, used in the trust notice. */
  readonly projectFile?: string;
  /** Project `[replace]` count, including untrusted ones the merge dropped. */
  readonly projectShortcutCount?: number;
  /** Host can apply a versioned async edit (false on Claude: no compare-and-set). */
  readonly asyncEdits?: boolean;
  readonly inlineMaxBytes?: number;
  readonly lexicon?: CollisionLexicon;
}

const SKIP_CODES = new Set(['invalid-shortcut', 'expansion-too-large', 'unsafe-text', 'invalid-reference']);

function put<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function basename(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || file;
}

function skipReason(message: string): string {
  const start = /starts with "([^"]+)"/.exec(message);
  if (start) return `starts with "${start[1]}"`;
  if (message.includes('larger than 16 KiB')) return 'larger than 16 KiB';
  if (message.includes('control') || message.includes('bidirectional') || message.includes('unsafe')) {
    return 'unsafe text';
  }
  if (message.includes('absolute') || message.includes('traversal') || message.includes('file')) {
    return 'bad file reference';
  }
  return 'skipped';
}

/**
 * Split merged replacements into the inline table and the long list, and
 * produce the one-line notices the host shows once per session.
 */
export function compileShortcuts(input: CompileInput): CompiledShortcuts {
  const inlineMax = input.inlineMaxBytes ?? INLINE_MAX_BYTES;
  const asyncEdits = input.asyncEdits ?? true;
  const inlineEntries: Record<string, string> = Object.create(null);
  const cursors: Record<string, number> = Object.create(null);
  const long: Record<string, string> = Object.create(null);
  const sources: Record<string, ShortcutSource> = Object.create(null);
  const templates: Record<string, CompiledTemplate> = Object.create(null);
  const descriptions: Record<string, string> = Object.create(null);
  const aliasesOf: Record<string, readonly string[]> = Object.create(null);
  const taken = new Set<string>();
  const notices: ShortcutNotice[] = [];

  const projectCount = input.projectShortcutCount ?? 0;
  const trust = input.trust ?? 'none';
  if ((trust === 'review' || trust === 'changed') && projectCount > 0) {
    const file = basename(input.projectFile ?? '.murmo.toml');
    notices.push({
      kind: 'trust',
      text: displayText(
        `${file} has ${projectCount} shortcut${projectCount === 1 ? '' : 's'}. Run "murmo trust" to review.`,
      ),
    });
  }

  for (const name of input.overrides ?? []) {
    notices.push({
      kind: 'override',
      text: displayText(`Project shortcut ${name} overrides your personal one.`),
    });
  }

  const skipped = (input.diagnostics ?? []).filter((d) => SKIP_CODES.has(d.code));
  if (skipped.length > 0) {
    const byFile = new Map<string, CompileDiagnostic[]>();
    for (const d of skipped) {
      const file = basename(d.file);
      const list = byFile.get(file) ?? [];
      list.push(d);
      byFile.set(file, list);
    }
    for (const [file, list] of byFile) {
      const first = list[0];
      if (!first) continue;
      notices.push({
        kind: 'skipped',
        text: displayText(
          `Skipped ${list.length} shortcut${list.length === 1 ? '' : 's'} in ${file} (line ${first.line}: ${skipReason(first.message)}).`,
        ),
      });
    }
  }

  const lexicon = input.lexicon;
  for (const entry of input.replacements) taken.add(entry.shortcut);

  for (const entry of input.replacements) {
    const source: ShortcutSource = entry.origin === 'project' ? 'project' : 'personal';
    put(sources, entry.shortcut, source);
    const parsed = parseTemplate(entry.text, defaultsOf(entry.fields));
    const text = parsed.expansion;
    if (!asyncEdits && text.includes('\t')) {
      notices.push({
        kind: 'skipped',
        text: displayText(`${entry.shortcut} contains a tab character; skipped on Claude (cursor drift)`),
      });
      continue;
    }
    if (parsed.names.length) {
      put(templates, entry.shortcut, {
        names: parsed.names,
        fields: parsed.fields,
        firstField: parsed.firstField,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        aliases: entry.aliases ?? [],
      });
      if (parsed.firstField !== null) put(cursors, entry.shortcut, parsed.firstField);
    }
    if (entry.description) put(descriptions, entry.shortcut, entry.description);
    const aliases: string[] = [];
    for (const alias of entry.aliases ?? []) {
      if (taken.has(alias)) {
        notices.push({
          kind: 'alias',
          text: displayText(`Alias ${alias} of ${entry.shortcut} collides with another shortcut; skipped.`),
        });
        continue;
      }
      taken.add(alias);
      aliases.push(alias);
      put(sources, alias, source);
      if (parsed.firstField !== null) put(cursors, alias, parsed.firstField);
      if (parsed.names.length) put(templates, alias, templates[entry.shortcut] as CompiledTemplate);
      if (entry.description) put(descriptions, alias, entry.description);
    }
    if (aliases.length) put(aliasesOf, entry.shortcut, aliases);
    const bytes = utf8Length(text);
    const store = (name: string) => {
      if (bytes <= inlineMax) put(inlineEntries, name, text);
      else if (bytes <= MAX_INSERT_BYTES) put(long, name, text);
    };
    store(entry.shortcut);
    for (const alias of aliases) store(alias);
    if (bytes > inlineMax && bytes <= MAX_INSERT_BYTES && !asyncEdits) {
      notices.push({
        kind: 'claude-size',
        text: displayText(`${entry.shortcut} is over 1 KiB: in Claude Code, insert it from the ; menu with Tab`),
      });
    }
    if (lexicon) {
      const kind: CollisionKind | null = collisionKind(entry.shortcut, lexicon);
      if (kind) notices.push({ kind: 'collision', text: displayText(collisionNotice(entry.shortcut, kind)) });
    }
  }

  return {
    inline: { format: 'literal-utf8-v1', entries: inlineEntries, cursors },
    long,
    sources,
    templates,
    descriptions,
    aliasesOf,
    fingerprint: input.fingerprint ?? null,
    notices,
  };
}

/** What the core registers as `replacements.entries`. Long ones stay off Space when the host cannot async-edit. */
export function replacementsForSpace(compiled: CompiledShortcuts, asyncEdits = true): Record<string, string> {
  const entries: Record<string, string> = Object.create(null);
  for (const [name, text] of Object.entries(compiled.inline.entries)) put(entries, name, text);
  if (asyncEdits) for (const [name, text] of Object.entries(compiled.long)) put(entries, name, text);
  return entries;
}

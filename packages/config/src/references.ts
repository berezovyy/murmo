// `{ file = "…" }` expansions. The portable part only decides what a read
// result means; the bounded no-follow reader lives with the runtime that owns a
// real file system (./node/reader.ts in Node and Bun, the helper for Claude,
// rust/src/reader.rs for the Codex wrapper). Loaded text and hashed bytes come
// from the same read (lesson 27).
import { makeDiagnostic } from './diagnostics.ts';
import {
  type ConfigFile,
  type ConfigOrigin,
  compareCodePoints,
  expansionProblem,
  type ShortcutEntry,
  sortDiagnostics,
} from './schema.ts';

/**
 * Why a reference was not loaded. The message for each is fixed here, so every
 * reader reports the same words.
 */
export type ReferenceProblem =
  | 'absolute'
  | 'traversal'
  | 'escapes'
  | 'not-found'
  | 'not-regular'
  | 'too-large'
  | 'invalid-utf8'
  | 'changed'
  | 'budget'
  | 'unreadable';

export const REFERENCE_PROBLEMS: Readonly<Record<ReferenceProblem, string>> = {
  absolute: 'is an absolute path',
  traversal: 'must be a relative path without ".." or "\\"',
  escapes: 'resolves outside the repository',
  'not-found': 'does not exist',
  'not-regular': 'is not a regular file',
  'too-large': 'is larger than 16 KiB',
  'invalid-utf8': 'is not UTF-8 text',
  changed: 'changed while it was read',
  budget: 'is past the 1 MiB or 128-file read budget of one load',
  unreadable: 'could not be read',
};

export type ReferenceRead =
  | { readonly status: 'ok'; readonly text: string }
  | { readonly status: 'refused'; readonly problem: ReferenceProblem };

export interface Shortcut {
  readonly shortcut: string;
  /** Exactly the text that is inserted. */
  readonly text: string;
  readonly origin: ConfigOrigin;
  /** The `file` it came from, as written. */
  readonly reference?: string;
}

export interface LoadedConfig extends ConfigFile {
  /** Usable expansions, sorted by shortcut. */
  readonly replacements: readonly Shortcut[];
}

/** Every `file` path the config refers to, once each, sorted. */
export function referencedPaths(config: ConfigFile): string[] {
  const paths = new Set<string>();
  for (const entry of config.shortcuts) if (entry.kind === 'file') paths.add(entry.path);
  return [...paths].sort(compareCodePoints);
}

/** Exactly one trailing LF or CRLF is dropped: files usually end with one (02-architecture). */
export function dropOneNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

/**
 * Turns parsed entries into expansions. `reads` holds the reader's answer for
 * each path from `referencedPaths`; a missing answer counts as unreadable.
 */
export function resolveShortcuts(config: ConfigFile, reads: ReadonlyMap<string, ReferenceRead>): LoadedConfig {
  const replacements: Shortcut[] = [];
  const diagnostics = [...config.diagnostics];
  const skip = (entry: ShortcutEntry, code: Parameters<typeof makeDiagnostic>[1], message: string) =>
    diagnostics.push(makeDiagnostic('warning', code, config.file, entry.at, message));
  for (const entry of config.shortcuts) {
    if (entry.kind === 'text') {
      replacements.push({ shortcut: entry.shortcut, text: entry.text, origin: config.origin });
      continue;
    }
    const read = reads.get(entry.path) ?? { status: 'refused', problem: 'unreadable' };
    if (read.status === 'refused') {
      skip(
        entry,
        'invalid-reference',
        `file "${entry.path}" of "${entry.shortcut}" ${REFERENCE_PROBLEMS[read.problem]}; skipped`,
      );
      continue;
    }
    const text = dropOneNewline(read.text);
    const refused = expansionProblem(text);
    if (refused) {
      skip(entry, refused.code, `file "${entry.path}" of "${entry.shortcut}" ${refused.message}; skipped`);
      continue;
    }
    replacements.push({ shortcut: entry.shortcut, text, origin: config.origin, reference: entry.path });
  }
  return { ...config, replacements, diagnostics: sortDiagnostics(diagnostics) };
}

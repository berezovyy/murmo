// Structured config diagnostics. Every text field passes through `displayText`
// when the diagnostic is made, so no raw control byte from a hostile file (or a
// hostile directory name) can reach a terminal through a notice (r12 K3).
import { displayText } from './text-policy.ts';

export type DiagnosticSeverity = 'error' | 'warning' | 'notice';

/**
 * - `too-large`: the file is over `CONFIG_LIMITS.configFileBytes`, refused before parsing.
 * - `unreadable`: not a regular file, not UTF-8, escapes the root, or changed while read.
 * - `too-deep`: arrays or inline tables nest deeper than `CONFIG_LIMITS.nestingDepth`.
 * - `parse`: not TOML 1.0.
 * - `unsupported-version`: `version` is not 1.
 * - `invalid-type`: a known key holds the wrong kind of value; it is ignored.
 * - `unknown-key`: reported once per key and ignored, so an older Murmo reads a newer file.
 * - `too-many-shortcuts`: more than `CONFIG_LIMITS.shortcutsPerFile`; `[replace]` is ignored.
 * - `invalid-shortcut`, `expansion-too-large`, `unsafe-text`, `invalid-reference`,
 *   `invalid-value`: one entry is skipped, the rest of the file still applies.
 * - `project-only-reduces`: a project file tried to turn something on.
 * - `untrusted`: project shortcuts and settings stay off until `murmo trust`.
 * - `override`: a project shortcut replaces a personal one.
 */
export type DiagnosticCode =
  | 'too-large'
  | 'unreadable'
  | 'too-deep'
  | 'parse'
  | 'unsupported-version'
  | 'invalid-type'
  | 'unknown-key'
  | 'too-many-shortcuts'
  | 'invalid-shortcut'
  | 'expansion-too-large'
  | 'unsafe-text'
  | 'invalid-reference'
  | 'invalid-value'
  | 'project-only-reduces'
  | 'untrusted'
  | 'override';

export interface Position {
  /** 1-based line in the file as written. */
  readonly line: number;
  /** 1-based column in code points. */
  readonly column: number;
}

export interface Diagnostic extends Position {
  readonly severity: DiagnosticSeverity;
  readonly code: DiagnosticCode;
  /** The file as given to the loader, escaped. */
  readonly file: string;
  /** One sentence, escaped. */
  readonly message: string;
  /** The source line the diagnostic points at, escaped and cut to `CONFIG_LIMITS.excerptCodePoints`. */
  readonly excerpt?: string;
}

export function makeDiagnostic(
  severity: DiagnosticSeverity,
  code: DiagnosticCode,
  file: string,
  at: Position,
  message: string,
  excerpt?: string,
): Diagnostic {
  const base = {
    severity,
    code,
    file: displayText(file),
    line: at.line,
    column: at.column,
    message: displayText(message),
  };
  return excerpt === undefined ? base : { ...base, excerpt: displayText(excerpt) };
}

/** `file:line:col: message`, then the excerpt on its own line when there is one. */
export function formatDiagnostic(d: Diagnostic): string {
  const head = `${d.file}:${d.line}:${d.column}: ${d.message}`;
  return d.excerpt === undefined ? head : `${head}\n  ${d.excerpt}`;
}

export const FILE_START: Position = { line: 1, column: 1 };

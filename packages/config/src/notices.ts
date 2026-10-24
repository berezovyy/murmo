// What a host shows when a session starts, from the session's config: one line
// saying Murmo is on and what it does, and each config file's problems with
// file and line. A wrong or broken `murmo.toml` used to fail silently: the
// diagnostics existed, nothing showed them. Shortcut notices (project trust,
// overrides, skipped entries) come from the shortcuts compiler, which also
// owns the shortcut-entry codes below.

import type { Diagnostic, DiagnosticCode } from './diagnostics.ts';
import type { LoadedSession } from './session.ts';

/** One `[replace]` entry skipped; the shortcuts compiler reports these per file. */
export const SHORTCUT_ENTRY_CODES: ReadonlySet<string> = new Set<DiagnosticCode>([
  'invalid-shortcut',
  'expansion-too-large',
  'unsafe-text',
  'invalid-reference',
]);

/** Codes whose message doesn't already say the whole file was dropped. */
const FILE_IGNORED: ReadonlySet<DiagnosticCode> = new Set(['parse', 'unsupported-version']);

/** The file name without its folder: notices are short, `murmo.toml` or `.murmo.toml`. */
export function baseName(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || file;
}

/**
 * One notice per file with errors or warnings: the first problem with its
 * line, and how many more there are. Notices (`untrusted`, `override`) and
 * skipped shortcut entries are reported elsewhere.
 */
export function configProblemNotices(diagnostics: readonly Diagnostic[]): string[] {
  const byFile = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) {
    if (d.severity === 'notice' || SHORTCUT_ENTRY_CODES.has(d.code)) continue;
    const list = byFile.get(d.file) ?? [];
    list.push(d);
    byFile.set(d.file, list);
  }
  const out: string[] = [];
  for (const [file, list] of byFile) {
    const [first] = list;
    if (!first) continue;
    const ignored = FILE_IGNORED.has(first.code) ? '; file ignored' : '';
    const more = list.length > 1 ? ` (and ${list.length - 1} more)` : '';
    out.push(`${baseName(file)}:${first.line}: ${first.message}${ignored}${more}`);
  }
  return out;
}

/**
 * The session's first line, shown until the first send: Murmo is on, how many
 * shortcuts it loaded, and whether autocorrect is on (and, when a project file
 * turned it off, which file did).
 */
export function sessionHint(session: Pick<LoadedSession, 'effective' | 'project'>): string {
  const count = session.effective.replacements.length;
  const shortcuts = count === 0 ? 'no shortcuts' : `${count} shortcut${count === 1 ? '' : 's'}`;
  const project = session.project;
  const autocorrect = session.effective.autocorrect
    ? 'autocorrect on'
    : project?.autocorrect === false
      ? `autocorrect off in ${baseName(project.file)}`
      : 'autocorrect off';
  return `murmo on · ${shortcuts} · ${autocorrect}`;
}

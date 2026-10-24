// The session config a helper loads for a host without a file system API
// (phase 14: Claude's project file goes through the helper). The helper's
// `config.load` replies with the JSON of `@murmo/config/node`'s
// `SessionConfig` minus its stamps, made by the Rust twin that
// `tools/config-parity.mjs` holds to the Node loader. This checks the reply's
// shape before a session acts on it: anything else is no config at all.
import type { Diagnostic } from './diagnostics.ts';
import type { EffectiveConfig } from './merge.ts';

/**
 * - `none`: no project file.
 * - `approved`: the snapshot's fingerprint and the repository identity match an approval.
 * - `review`: never approved.
 * - `changed`: approved once, but the content, a reference, a symlink or the clone changed.
 * - `not-approvable`: ignored file or unreadable reference; fix the file first.
 */
export type TrustState = 'approved' | 'review' | 'changed' | 'not-approvable';

/** What a host says about the project file at session start. */
export interface ProjectSummary {
  /** The project file as the loader named it, escaped. */
  readonly file: string;
  /** Its usable `[replace]` shortcuts, approved or not. */
  readonly shortcuts: number;
  /** Its `[autocorrect] enabled`, when it sets one (a project may only turn it off). */
  readonly autocorrect?: boolean;
}

export interface LoadedSession {
  readonly trust: TrustState | 'none';
  readonly effective: EffectiveConfig;
  /** Absent when there is no project file. */
  readonly project?: ProjectSummary;
}

/** The summary of a loaded project file (`SessionConfig.project.config`). */
export function projectSummary(config: {
  readonly file: string;
  readonly replacements: readonly unknown[];
  readonly autocorrect?: boolean;
}): ProjectSummary {
  return {
    file: config.file,
    shortcuts: config.replacements.length,
    ...(config.autocorrect === undefined ? {} : { autocorrect: config.autocorrect }),
  };
}

const TRUST: readonly string[] = ['none', 'approved', 'review', 'changed', 'not-approvable'];

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const optional = (v: unknown, check: (v: unknown) => boolean): boolean => v === undefined || check(v);

function isShortcut(v: unknown): boolean {
  return (
    isRecord(v) &&
    typeof v.shortcut === 'string' &&
    typeof v.text === 'string' &&
    (v.origin === 'user' || v.origin === 'project') &&
    optional(v.reference, (r) => typeof r === 'string') &&
    optional(v.description, (d) => typeof d === 'string') &&
    optional(v.aliases, isStrings) &&
    optional(v.fields, isRecord)
  );
}

function isDiagnostic(v: unknown): v is Diagnostic {
  return (
    isRecord(v) &&
    typeof v.severity === 'string' &&
    typeof v.code === 'string' &&
    typeof v.file === 'string' &&
    typeof v.message === 'string' &&
    typeof v.line === 'number' &&
    typeof v.column === 'number' &&
    optional(v.excerpt, (e) => typeof e === 'string')
  );
}

function isPlugin(v: unknown): boolean {
  return isRecord(v) && isRecord(v.settings) && optional(v.enabled, (e) => typeof e === 'boolean');
}

function isEffective(v: unknown): v is EffectiveConfig {
  if (!isRecord(v)) return false;
  const flags = ['autocorrect', 'phrasesLearn', 'historyEnabled', 'private', 'events', 'eventsFailOpen'];
  return (
    Array.isArray(v.replacements) &&
    v.replacements.every(isShortcut) &&
    isStrings(v.overrides) &&
    isStrings(v.protect) &&
    flags.every((flag) => typeof v[flag] === 'boolean') &&
    isRecord(v.plugins) &&
    Object.values(v.plugins).every(isPlugin) &&
    Array.isArray(v.diagnostics) &&
    v.diagnostics.every(isDiagnostic) &&
    optional(v.language, (l) => typeof l === 'string') &&
    optional(v.pluginOrder, isStrings) &&
    optional(v.names, isRecord)
  );
}

/** The reply's `project.config`, summarized; a malformed one is no summary, never a refused session. */
function projectFromJson(value: unknown): ProjectSummary | undefined {
  if (!isRecord(value) || !isRecord(value.config)) return undefined;
  const { file, replacements, autocorrect } = value.config;
  if (
    typeof file !== 'string' ||
    !Array.isArray(replacements) ||
    !optional(autocorrect, (a) => typeof a === 'boolean')
  ) {
    return undefined;
  }
  return projectSummary({
    file,
    replacements,
    ...(autocorrect === undefined ? {} : { autocorrect: autocorrect as boolean }),
  });
}

/** The session in a `config.load` reply's `session`, or undefined when it isn't a well-formed one. */
export function sessionFromJson(value: unknown): LoadedSession | undefined {
  if (!isRecord(value) || typeof value.trust !== 'string' || !TRUST.includes(value.trust)) return undefined;
  if (!isEffective(value.effective)) return undefined;
  const project = projectFromJson(value.project);
  return { trust: value.trust as LoadedSession['trust'], effective: value.effective, ...(project ? { project } : {}) };
}

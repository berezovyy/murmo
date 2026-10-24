// Loads and checks every fixture file before anything runs. A malformed case
// that a runner would skip silently is the vacuous-test failure (E13), so
// loading is strict: schema-valid, indexed with the right size, unique IDs,
// known plugins, existing project folders, moved bytes unchanged, invisible
// characters escaped. Portable: the Node side supplies file text and hashes.

import type {
  EditorCase,
  EditorOpsFile,
  GeneratorFile,
  MovedFile,
  PluginRef,
  PureCase,
  PureFnFile,
  Step,
  SuiteIndex,
} from '@murmo/fixtures';
import { type SchemaSet, validate } from './schema.ts';
import type { LoadedSuite } from './types.ts';

export interface FixtureSource {
  /** Raw text of every .json file under fixtures/, keyed by path relative to fixtures/. */
  json: Record<string, string>;
  /** fixtures/schema/*.json, keyed by file name. */
  schemas: SchemaSet;
  exists(path: string): boolean;
  /** SHA-256 and byte size of a file relative to fixtures/; undefined if missing. */
  stat(path: string): { sha256: string; bytes: number } | undefined;
}

export interface PluginRegistry {
  fixture: Record<string, { file: string; source: string; why: string }>;
  provided: Record<string, string>;
}

export interface Loaded {
  suites: LoadedSuite[];
  plugins: PluginRegistry;
  problems: string[];
}

export const indexFile = 'suites.json';
export const pluginsFile = 'plugins.json';

const schemaOf: Record<string, string> = {
  'editor-ops/v1': 'editor-ops.v1.json',
  'pure-fn/v1': 'pure-fn.v1.json',
  'generator/v1': 'generator.v1.json',
  'moved/v1': 'moved.v1.json',
};

/**
 * Characters that must be written as \u escapes: controls, format characters
 * (ZWJ, bidi, BOM), combining marks, variation selectors, non-ASCII spaces.
 * Raw, an editor can drop or normalize them without anyone seeing.
 */
const invisible = /(?![ \n])[\p{Cc}\p{Cf}\p{M}\p{Z}\p{Co}]/u;

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');

function parse(path: string, text: string, problems: string[]): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    problems.push(`${path}: not valid JSON (${(error as Error).message})`);
    return undefined;
  }
}

function schemaProblems(schemas: SchemaSet, schema: string, path: string, value: unknown): string[] {
  return validate(schemas, schema, value).map((e) => `${path}: ${e.path} ${e.message}`);
}

/** Variant names a case expands to; `[undefined]` for a case without variants. */
export function variantsOf(c: EditorCase): (string | undefined)[] {
  return c.variants?.states ?? c.variants?.editorModes ?? [undefined];
}

function usesVariant(steps: readonly Step[]): boolean {
  return steps.some(
    (s) =>
      'state' in s &&
      (s.state === '$variant' ||
        (typeof s.state === 'object' && 'editorMode' in s.state && s.state.editorMode === '$variant')),
  );
}

function pluginName(ref: PluginRef): string {
  return typeof ref === 'string' ? ref : ref.plugin;
}

/** The host loads `project`'s `.murmo.toml` through its trust check (phase 14), and the runner can approve it. */
const PROJECT_CONFIG = 'host.project-config';

/** The runner installs `installed` plugins with `murmo plugin add` before the host starts. */
const INSTALLED_PLUGINS = 'host.installed-plugins';

/** The runner writes `hostConfig`'s files into the real host's config folder before setup. */
const HOST_CONFIG_FILES = 'host.config-files';

function checkEditorCases(path: string, cases: EditorCase[], plugins: PluginRegistry, src: FixtureSource): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const c of cases) {
    const at = `${path} ${c.id}`;
    if (ids.has(c.id)) problems.push(`${at}: duplicate case id`);
    ids.add(c.id);
    if (c.variants?.states && c.variants.editorModes) problems.push(`${at}: one variant kind per case`);
    if (Boolean(c.variants) !== usesVariant(c.steps)) {
      problems.push(`${at}: variants and "$variant" state steps must come together`);
    }
    for (const ref of c.plugins ?? []) {
      const name = pluginName(ref);
      if (!plugins.fixture[name] && !plugins.provided[name]) problems.push(`${at}: unknown plugin "${name}"`);
    }
    if (c.project && !src.exists(c.project)) problems.push(`${at}: project folder "${c.project}" does not exist`);
    if (c.projectTrust && !(c.requires ?? []).includes(PROJECT_CONFIG)) {
      // A subject that never reads `.murmo.toml` would pass the unreviewed case for the wrong reason.
      problems.push(`${at}: "projectTrust" needs "requires": ["${PROJECT_CONFIG}"]`);
    }
    if (c.hostConfig && !src.exists(c.hostConfig))
      problems.push(`${at}: host config folder "${c.hostConfig}" does not exist`);
    if (c.hostConfig && !(c.requires ?? []).includes(HOST_CONFIG_FILES)) {
      // A subject without the host's own config would pass the case for the wrong reason.
      problems.push(`${at}: "hostConfig" needs "requires": ["${HOST_CONFIG_FILES}"]`);
    }
    for (const plugin of c.installed ?? []) {
      if (!src.exists(`${plugin.folder}/murmo.plugin.json`)) {
        problems.push(`${at}: installed plugin folder "${plugin.folder}" has no murmo.plugin.json`);
      }
    }
    if (c.installed && !(c.requires ?? []).includes(INSTALLED_PLUGINS)) {
      // A subject that never installs the plugin would pass a "disabled" case for the wrong reason.
      problems.push(`${at}: "installed" needs "requires": ["${INSTALLED_PLUGINS}"]`);
    }
    if (c.timing?.baseline && !cases.some((other) => other.id === c.timing?.baseline?.case)) {
      problems.push(`${at}: timing baseline "${c.timing.baseline.case}" is not a case in this file`);
    }
    if ((c.timing?.keyMs !== undefined || c.timing?.changeMs !== undefined) && !c.control) {
      problems.push(`${at}: a timing budget needs a same-time control run ("control": true; lesson 65)`);
    }
  }
  return problems;
}

function withDefaults(file: EditorOpsFile): EditorCase[] {
  const defaults = file.defaults ?? {};
  return file.cases.map((c) => ({ ...defaults, ...c }));
}

/**
 * One editor-ops file a bundle carries, without the fixtures folder (the
 * packed `murmo plugin test`). `check` validates the same file from disk.
 */
export function editorOpsSuite(file: string, owner: string, data: EditorOpsFile): LoadedSuite {
  const cases = withDefaults(data);
  const variants = cases.reduce((n, c) => n + variantsOf(c).length, 0);
  return { kind: 'editor-ops', file, owner, declared: { cases: cases.length, variants }, cases };
}

function pureCases(path: string, file: PureFnFile, src: FixtureSource, problems: string[]): PureCase[] {
  if (file.cases) return file.cases.map((c) => (file.fn && !c.fn ? { ...c, fn: file.fn } : c));
  const table = file.table;
  if (!table) return [];
  const tablePath = dirOf(path) + table.file;
  const text = src.json[tablePath];
  if (text === undefined) {
    problems.push(`${path}: table file "${tablePath}" not found`);
    return [];
  }
  const data = parse(tablePath, text, problems) as Record<string, unknown> | undefined;
  const rows = data?.[table.cases];
  if (!Array.isArray(rows)) {
    problems.push(`${path}: "${table.cases}" in ${tablePath} is not a list`);
    return [];
  }
  return rows.map((row: Record<string, unknown>, i) => ({
    id: String((table.id && row[table.id]) ?? `${i + 1}`),
    ...(file.fn ? { fn: file.fn } : {}),
    input: row[table.input],
    output: row[table.output],
  }));
}

export function loadFixtures(src: FixtureSource): Loaded {
  const problems: string[] = [];
  const indexText = src.json[indexFile];
  const pluginText = src.json[pluginsFile];
  if (indexText === undefined || pluginText === undefined) {
    return { suites: [], plugins: { fixture: {}, provided: {} }, problems: [`missing ${indexFile} or ${pluginsFile}`] };
  }
  const index = parse(indexFile, indexText, problems) as SuiteIndex;
  problems.push(...schemaProblems(src.schemas, 'suites.v1.json', indexFile, index));
  const registry = parse(pluginsFile, pluginText, problems) as PluginRegistry & { kind: string };
  problems.push(...schemaProblems(src.schemas, 'plugins.v1.json', pluginsFile, registry));
  const plugins: PluginRegistry = { fixture: registry?.fixture ?? {}, provided: registry?.provided ?? {} };
  for (const [name, p] of Object.entries(plugins.fixture)) {
    if (!src.exists(p.file)) problems.push(`${pluginsFile}: fixture plugin "${name}" file ${p.file} does not exist`);
    if (plugins.provided[name]) problems.push(`${pluginsFile}: "${name}" is both a fixture and a provided plugin`);
  }
  if (problems.length) return { suites: [], plugins, problems };

  const indexed = new Map(index.suites.map((s) => [s.file, s]));
  if (indexed.size !== index.suites.length) problems.push(`${indexFile}: a file is listed twice`);
  // Moved files keep their exact bytes, so they are exempt from the escape rule and need no index entry.
  const moved = new Set<string>();
  const hostConfigs = new Set<string>();
  const suites: LoadedSuite[] = [];

  for (const entry of index.suites) {
    const path = entry.file;
    const text = src.json[path];
    if (text === undefined) {
      problems.push(`${indexFile}: ${path} does not exist`);
      continue;
    }
    const data = parse(path, text, problems) as { kind?: string } | undefined;
    const schema = data?.kind ? schemaOf[data.kind] : undefined;
    if (!data || !schema) {
      problems.push(`${path}: unknown kind ${JSON.stringify(data?.kind)}`);
      continue;
    }
    const errors = schemaProblems(src.schemas, schema, path, data);
    if (errors.length) {
      problems.push(...errors);
      continue;
    }
    if (data.kind === 'moved/v1') {
      for (const f of (data as MovedFile).files) {
        const target = dirOf(path) + f.path;
        moved.add(target);
        const stat = src.stat(target);
        if (!stat) problems.push(`${path}: moved file ${target} is missing`);
        else if (stat.sha256 !== f.sha256 || stat.bytes !== f.bytes) {
          problems.push(`${path}: ${target} changed (sha256 ${stat.sha256}, ${stat.bytes} bytes; source ${f.source})`);
        }
      }
      continue;
    }
    if (data.kind === 'generator/v1') {
      const g = data as GeneratorFile;
      if (g.reference && g.reference.size !== g.sizes.nightly) {
        problems.push(`${path}: reference counts are for ${g.reference.size} streams, nightly runs ${g.sizes.nightly}`);
      }
      if (g.target.kind === 'editor-ops') {
        for (const ref of g.target.plugins ?? []) {
          const name = pluginName(ref);
          if (!plugins.fixture[name] && !plugins.provided[name]) problems.push(`${path}: unknown plugin "${name}"`);
        }
      }
      suites.push({ kind: 'generator', file: path, owner: entry.owner, generator: g });
      continue;
    }
    if (data.kind === 'editor-ops/v1') {
      const cases = withDefaults(data as EditorOpsFile);
      problems.push(...checkEditorCases(path, cases, plugins, src));
      for (const c of cases) if (c.hostConfig) hostConfigs.add(`${c.hostConfig}/`);
      for (const c of cases) for (const plugin of c.installed ?? []) hostConfigs.add(`${plugin.folder}/`);
      const variants = cases.reduce((n, c) => n + variantsOf(c).length, 0);
      if (entry.cases !== cases.length) problems.push(`${path}: declares ${entry.cases} cases, loaded ${cases.length}`);
      if (entry.variants !== variants)
        problems.push(`${path}: declares ${entry.variants} variants, expands to ${variants}`);
      suites.push({
        kind: 'editor-ops',
        file: path,
        owner: entry.owner,
        declared: { cases: cases.length, variants },
        cases,
      });
      continue;
    }
    const cases = pureCases(path, data as PureFnFile, src, problems);
    const ids = new Set<string>();
    for (const c of cases) {
      if (ids.has(c.id)) problems.push(`${path} ${c.id}: duplicate case id`);
      ids.add(c.id);
      if (!c.fn) problems.push(`${path} ${c.id}: no function named, in the case or the file`);
    }
    if (entry.cases !== cases.length) problems.push(`${path}: declares ${entry.cases} cases, loaded ${cases.length}`);
    suites.push({ kind: 'pure-fn', file: path, owner: entry.owner, declared: { cases: cases.length }, cases });
  }

  for (const [path, text] of Object.entries(src.json)) {
    if (path.startsWith('schema/') || path === indexFile || path === pluginsFile || moved.has(path)) continue;
    // A host's own settings file (OpenCode's cli.json) or an installed plugin's manifest is data a case copies, not a suite.
    const hostFile = [...hostConfigs].some((folder) => path.startsWith(folder));
    if (!indexed.has(path) && !hostFile) problems.push(`${path}: not listed in ${indexFile}, so it would never run`);
    const match = invisible.exec(text);
    if (match) {
      const line = text.slice(0, match.index).split('\n').length;
      const code = (match[0].codePointAt(0) ?? 0).toString(16).padStart(4, '0');
      problems.push(`${path}:${line}: raw U+${code.toUpperCase()}; write it as a \\u escape`);
    }
  }
  return { suites, plugins, problems };
}

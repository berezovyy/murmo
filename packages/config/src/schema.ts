// Schema v1 of `murmo.toml` and `.murmo.toml`: limits, types and per-entry
// failures. A file that can't be read or parsed is ignored alone (fail open per
// file); a bad entry or setting is skipped alone, with a diagnostic that says
// where it is. The Rust twin (rust/src/schema.rs) must give the same result and
// the same diagnostics for every fixture.
import { type Diagnostic, type DiagnosticCode, makeDiagnostic, type Position } from './diagnostics.ts';
import { CONFIG_LIMITS } from './limits.ts';
import { codePointLength, excerptAt, type Locator, normalizeToml, scanSource, utf8Length } from './source.ts';
import { unsafeText } from './text-policy.ts';
import { parseToml, type TomlTable } from './toml.ts';

export type ConfigOrigin = 'user' | 'project';

export type ShortcutEntry =
  | { readonly kind: 'text'; readonly shortcut: string; readonly text: string; readonly at: Position }
  | { readonly kind: 'file'; readonly shortcut: string; readonly path: string; readonly at: Position };

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** `[plugins.<id>]`: the host-owned switch apart from what the plugin itself sees. */
export interface PluginTable {
  /** Host-owned; never passed to the plugin (phase 03 hand-off). */
  readonly enabled?: boolean;
  /** Checked against the plugin's manifest schema with `resolveSettings` before its factory runs. */
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly at: Position;
}

export const NAMES_LANGUAGES = ['rust', 'typescript', 'javascript', 'python', 'go'] as const;

export interface NamesSettings {
  readonly enabled?: boolean;
  readonly key?: string;
  readonly languages?: readonly string[];
  readonly maxFileBytes?: number;
}

export interface ConfigFile {
  readonly file: string;
  readonly origin: ConfigOrigin;
  /** `ignored`: the whole file is ignored (too large, unreadable, too deep, not TOML, unknown version). */
  readonly status: 'ok' | 'ignored';
  readonly language?: string;
  /** Sorted by shortcut in code point order. */
  readonly shortcuts: readonly ShortcutEntry[];
  /** `[words] protect`, in file order, without duplicates. */
  readonly protect: readonly string[];
  /** `[autocorrect] enabled`. */
  readonly autocorrect?: boolean;
  /** `[names]` on-request project-name menu (phase 36). */
  readonly names?: NamesSettings;
  /** `[phrases] learn`. Opt-in; default is off. */
  readonly phrasesLearn?: boolean;
  /** `[history] enabled`. Opt-in; default is off. */
  readonly historyEnabled?: boolean;
  /** `[plugins] order`. */
  readonly pluginOrder?: readonly string[];
  readonly plugins: Readonly<Record<string, PluginTable>>;
  /** `[privacy] private`. */
  readonly private?: boolean;
  /** `[events] enabled`. Opt-in preview; absent means off. */
  readonly events?: boolean;
  /** `[events] failOpen`. Only where Murmo owns the barrier (Pi). */
  readonly eventsFailOpen?: boolean;
  /** Sorted by position, then code. */
  readonly diagnostics: readonly Diagnostic[];
}

export interface ConfigSource {
  /** Shown in diagnostics: the path as the loader found it. */
  readonly file: string;
  readonly origin: ConfigOrigin;
}

/** Same rule as the manifest `name` in @murmo/api (manifest.ts). */
const PLUGIN_ID = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]{0,63}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const SHORTCUT_FIRST = /^[\p{Alphabetic}\p{N};,\\=+]/u;
/**
 * Whitespace as one explicit set, so JS and Rust agree: JavaScript's `\s`
 * plus U+0085, which Rust counts as whitespace (it is also a C1 control).
 */
const WHITESPACE =
  /[\t\n\v\f\r \u0085\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]/u;

/** A file the loader could not hand to the parser at all. */
export function ignoredFile(
  source: ConfigSource,
  code: DiagnosticCode,
  message: string,
  at: Position = { line: 1, column: 1 },
): ConfigFile {
  return {
    ...source,
    status: 'ignored',
    shortcuts: [],
    protect: [],
    plugins: {},
    diagnostics: [makeDiagnostic('error', code, source.file, at, message)],
  };
}

/** Code point order, the order Rust's `BTreeMap<String, _>` iterates in. */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return surrogatesLast(x) - surrogatesLast(y);
  }
  return a.length - b.length;
}

/**
 * At the first differing UTF-16 unit, code point order equals unit order
 * except that surrogates (code points above U+FFFF) sort after U+E000..U+FFFF.
 */
function surrogatesLast(unit: number): number {
  if (unit < 0xd800) return unit;
  return unit >= 0xe000 ? unit - 0x800 : unit + 0x2000;
}

/** Sets an own property, so a key such as `__proto__` stays data. */
export function put<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isTable(value: unknown): value is TomlTable {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function sortedKeys(table: TomlTable): string[] {
  return Object.keys(table).sort(compareCodePoints);
}

/** Why `key` can't be a shortcut, or null. Checked in this order in both languages. */
export function shortcutProblem(key: string): string | null {
  if (unsafeText(key) !== null) return 'contains a control or bidirectional character';
  if (key.length === 0) return 'is empty';
  if (codePointLength(key) > CONFIG_LIMITS.shortcutCodePoints) return 'is longer than 32 characters';
  if (!SHORTCUT_FIRST.test(key)) return 'must start with a letter, a digit or one of ; , \\ = +';
  if (WHITESPACE.test(key)) return 'contains whitespace';
  return null;
}

/** Why `word` can't be protected, or null. */
function wordProblem(word: string): string | null {
  if (unsafeText(word) !== null) return 'contains a control or bidirectional character';
  if (word.length === 0) return 'is empty';
  if (codePointLength(word) > CONFIG_LIMITS.wordCodePoints) return 'is longer than 64 characters';
  if (WHITESPACE.test(word)) return 'contains whitespace';
  return null;
}

/** Why a `file` reference is refused before any read, or null (r8 § 54, r12 K2). */
export function referencePathProblem(path: string): 'absolute' | 'traversal' | null {
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return 'absolute';
  if (path.length === 0 || path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) {
    return 'traversal';
  }
  return null;
}

/** TOML data as JSON for plugin settings, or undefined when it has no JSON form. */
function toJson(value: unknown): JsonValue | undefined {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      // At or beyond 2^53 a JS number is no longer exact, while Rust keeps an
      // i64 exact: refuse those in both, so the two never disagree on a value.
      return Number.isFinite(value) && Math.abs(value) < 2 ** 53 ? value : undefined;
    case 'object': {
      if (Array.isArray(value)) {
        const out: JsonValue[] = [];
        for (const item of value) {
          const json = toJson(item);
          if (json === undefined) return undefined;
          out.push(json);
        }
        return out;
      }
      if (!isTable(value)) return undefined;
      const out: Record<string, JsonValue> = {};
      for (const key of sortedKeys(value)) {
        const json = toJson(value[key]);
        if (json === undefined) return undefined;
        put(out, key, json);
      }
      return out;
    }
    default:
      // TOML datetimes and anything else without a JSON form.
      return undefined;
  }
}

/** Collects one file's diagnostics, each placed by the key locator. */
interface FileChecker {
  readonly diagnostics: Diagnostic[];
  at(path: readonly string[]): Position;
  report(severity: 'error' | 'warning', code: DiagnosticCode, path: readonly string[], message: string): void;
  unknown(path: readonly string[], label: string): void;
}

function fileChecker(origin: ConfigSource, source: string, locator: Locator): FileChecker {
  const diagnostics: Diagnostic[] = [];
  const checker: FileChecker = {
    diagnostics,
    at: (path) => locator.locate(path),
    report(severity, code, path, message) {
      const at = locator.locate(path);
      diagnostics.push(makeDiagnostic(severity, code, origin.file, at, message, excerptAt(source, at.line)));
    },
    unknown(path, label) {
      checker.report('warning', 'unknown-key', path, `unknown key ${label} ignored`);
    },
  };
  return checker;
}

/**
 * Parses and checks one config file. `text` is the decoded file; the loader has
 * already refused files over `CONFIG_LIMITS.configFileBytes` before decoding,
 * and this checks again for callers that hand over a string (Claude's `$.fs`).
 */
export function parseConfig(text: string, origin: ConfigSource): ConfigFile {
  if (utf8Length(text) > CONFIG_LIMITS.configFileBytes) {
    return ignoredFile(origin, 'too-large', 'file is larger than 256 KiB and was not read');
  }
  const source = normalizeToml(text);
  const { overflow, locator } = scanSource(source);
  if (overflow) {
    return withExcerpt(
      ignoredFile(origin, 'too-deep', 'arrays or tables nest deeper than 32 levels; file ignored', overflow),
      source,
    );
  }
  const parsed = parseToml(source);
  if (!parsed.ok) {
    return withExcerpt(ignoredFile(origin, 'parse', `not valid TOML: ${parsed.message}`, parsed.at), source);
  }
  const data = parsed.table;
  const check = fileChecker(origin, source, locator);

  if (Object.hasOwn(data, 'version')) {
    const version = data.version;
    if (version !== 1) {
      return withExcerpt(
        ignoredFile(
          origin,
          'unsupported-version',
          'unsupported version; this Murmo reads version 1',
          check.at(['version']),
        ),
        source,
      );
    }
  }

  let language: string | undefined;
  let shortcuts: ShortcutEntry[] = [];
  let protect: string[] = [];
  let autocorrect: boolean | undefined;
  let names: NamesSettings | undefined;
  let phrasesLearn: boolean | undefined;
  let historyEnabled: boolean | undefined;
  let pluginOrder: string[] | undefined;
  let plugins: Record<string, PluginTable> = {};
  let privacy: boolean | undefined;
  let events: boolean | undefined;
  let eventsFailOpen: boolean | undefined;

  for (const key of sortedKeys(data)) {
    const value = data[key];
    switch (key) {
      case 'version':
        break;
      case 'language':
        if (typeof value !== 'string') check.report('warning', 'invalid-type', [key], 'language must be a string');
        else if (!LANGUAGE.test(value)) {
          check.report('warning', 'invalid-value', [key], 'language must be a language tag such as "en"');
        } else language = value;
        break;
      case 'replace':
        shortcuts = checkReplace(check, value);
        break;
      case 'words':
        protect = checkWords(check, value);
        break;
      case 'autocorrect':
        autocorrect = checkSwitch(check, value, 'autocorrect', 'enabled');
        break;
      case 'names':
        names = checkNames(check, value);
        break;
      case 'phrases':
        phrasesLearn = checkSwitch(check, value, 'phrases', 'learn');
        break;
      case 'history':
        historyEnabled = checkSwitch(check, value, 'history', 'enabled');
        break;
      case 'plugins':
        ({ order: pluginOrder, tables: plugins } = checkPlugins(check, value));
        break;
      case 'privacy':
        privacy = checkSwitch(check, value, 'privacy', 'private');
        break;
      case 'events':
        ({ enabled: events, failOpen: eventsFailOpen } = checkEvents(check, value));
        break;
      default:
        check.unknown([key], `"${key}"`);
    }
  }
  if (origin.origin === 'project') {
    // A project file can only make Murmo do less (02-architecture § Text replacements).
    if (autocorrect === true) {
      check.report(
        'warning',
        'project-only-reduces',
        ['autocorrect', 'enabled'],
        'a project file can only turn autocorrect off; "enabled = true" ignored',
      );
      autocorrect = undefined;
    }
    if (names?.enabled === true) {
      check.report(
        'warning',
        'project-only-reduces',
        ['names', 'enabled'],
        'a project file can only turn names off; "enabled = true" ignored',
      );
      const { enabled: _ignored, ...rest } = names;
      names = Object.keys(rest).length ? rest : undefined;
    }
    if (phrasesLearn === true) {
      check.report(
        'warning',
        'project-only-reduces',
        ['phrases', 'learn'],
        'a project file can only turn phrase learning off; "learn = true" ignored',
      );
      phrasesLearn = undefined;
    }
    if (historyEnabled === true) {
      check.report(
        'warning',
        'project-only-reduces',
        ['history', 'enabled'],
        'a project file can only turn history off; "enabled = true" ignored',
      );
      historyEnabled = undefined;
    }
    if (privacy === false) privacy = undefined;
    if (events === true) {
      check.report(
        'warning',
        'project-only-reduces',
        ['events', 'enabled'],
        'a project file can only turn events off; "enabled = true" ignored',
      );
      events = undefined;
    }
    if (pluginOrder !== undefined) {
      check.report(
        'warning',
        'project-only-reduces',
        ['plugins', 'order'],
        'plugin order in a project file is ignored; only your murmo.toml sets it',
      );
      pluginOrder = undefined;
    }
    for (const [id, table] of Object.entries(plugins)) {
      if (table.enabled !== true) continue;
      check.report(
        'warning',
        'project-only-reduces',
        ['plugins', id, 'enabled'],
        `a project file can only turn plugin "${id}" off; "enabled = true" ignored`,
      );
      put(plugins, id, { settings: table.settings, at: table.at });
    }
  }

  const file: ConfigFile = {
    ...origin,
    status: 'ok',
    shortcuts,
    protect,
    plugins,
    diagnostics: sortDiagnostics(check.diagnostics),
    ...(language === undefined ? {} : { language }),
    ...(autocorrect === undefined ? {} : { autocorrect }),
    ...(names === undefined ? {} : { names }),
    ...(phrasesLearn === undefined ? {} : { phrasesLearn }),
    ...(historyEnabled === undefined ? {} : { historyEnabled }),
    ...(pluginOrder === undefined ? {} : { pluginOrder }),
    ...(privacy === undefined ? {} : { private: privacy }),
    ...(events === undefined ? {} : { events }),
    ...(eventsFailOpen === undefined ? {} : { eventsFailOpen }),
  };
  return file;
}

function withExcerpt(file: ConfigFile, source: string): ConfigFile {
  const [first] = file.diagnostics;
  if (!first) return file;
  const excerpt = excerptAt(source, first.line);
  if (excerpt === undefined) return file;
  return {
    ...file,
    diagnostics: [makeDiagnostic(first.severity, first.code, first.file, first, first.message, excerpt)],
  };
}

export function sortDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
  return [...list].sort(
    (a, b) =>
      a.line - b.line ||
      a.column - b.column ||
      compareCodePoints(a.code, b.code) ||
      compareCodePoints(a.message, b.message),
  );
}

function checkReplace(check: FileChecker, value: unknown): ShortcutEntry[] {
  if (!isTable(value)) {
    check.report('warning', 'invalid-type', ['replace'], '[replace] must be a table');
    return [];
  }
  const keys = sortedKeys(value);
  if (keys.length > CONFIG_LIMITS.shortcutsPerFile) {
    check.report(
      'error',
      'too-many-shortcuts',
      ['replace'],
      `[replace] has ${keys.length} shortcuts; at most 1000 per file, so none were loaded`,
    );
    return [];
  }
  const entries: ShortcutEntry[] = [];
  for (const shortcut of keys) {
    const path = ['replace', shortcut];
    const problem = shortcutProblem(shortcut);
    if (problem) {
      check.report('warning', 'invalid-shortcut', path, `shortcut "${shortcut}" ${problem}; skipped`);
      continue;
    }
    const entry = value[shortcut];
    if (typeof entry === 'string') {
      const refused = expansionProblem(entry);
      if (refused)
        check.report('warning', refused.code, path, `expansion of "${shortcut}" ${refused.message}; skipped`);
      else entries.push({ kind: 'text', shortcut, text: entry, at: check.at(path) });
    } else if (isTable(entry) && Object.hasOwn(entry, 'file')) {
      for (const extra of sortedKeys(entry)) {
        if (extra !== 'file') check.unknown([...path, extra], `"${extra}" in "${shortcut}"`);
      }
      const file = entry.file;
      if (typeof file !== 'string') {
        check.report('warning', 'invalid-type', path, `file of "${shortcut}" must be a string; skipped`);
      } else {
        entries.push({ kind: 'file', shortcut, path: file, at: check.at(path) });
      }
    } else {
      check.report(
        'warning',
        'invalid-type',
        path,
        `shortcut "${shortcut}" must be a string or { file = "\u{2026}" }; skipped`,
      );
    }
  }
  return entries;
}

/** Why an expansion can't be inserted, or null: 16 KiB of UTF-8 and the text policy (r12 K3). */
export function expansionProblem(text: string): { code: DiagnosticCode; message: string } | null {
  // A UTF-16 unit is at most 3 UTF-8 bytes, so short text needs no count.
  if (text.length * 3 > CONFIG_LIMITS.expansionBytes && utf8Length(text) > CONFIG_LIMITS.expansionBytes) {
    return { code: 'expansion-too-large', message: 'is larger than 16 KiB' };
  }
  const unsafe = unsafeText(text);
  return unsafe ? { code: 'unsafe-text', message: `contains a ${unsafe}` } : null;
}

function checkWords(check: FileChecker, value: unknown): string[] {
  if (!isTable(value)) {
    check.report('warning', 'invalid-type', ['words'], '[words] must be a table');
    return [];
  }
  const words: string[] = [];
  for (const key of sortedKeys(value)) {
    if (key !== 'protect') {
      check.unknown(['words', key], `"${key}" in [words]`);
      continue;
    }
    const list = value[key];
    if (!Array.isArray(list)) {
      check.report('warning', 'invalid-type', ['words', key], 'protect must be a list of words');
      continue;
    }
    for (const word of list) {
      if (typeof word !== 'string') {
        check.report('warning', 'invalid-type', ['words', key], 'protect must be a list of words');
        continue;
      }
      const problem = wordProblem(word);
      if (problem) check.report('warning', 'invalid-value', ['words', key], `word "${word}" ${problem}; skipped`);
      else if (!words.includes(word)) words.push(word);
    }
  }
  return words;
}

const NAME_LANG = new Set<string>(NAMES_LANGUAGES);

const NAMED_KEY = new Set([
  'space',
  'Tab',
  'Enter',
  'Backspace',
  'Escape',
  'Up',
  'Down',
  'Left',
  'Right',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
]);

/** Same grammar as `@murmo/api` `isCanonicalKey`, inlined so parse stays a data pass. */
function namesKeyOk(id: string): boolean {
  let rest = id;
  const used: string[] = [];
  for (const modifier of ['Ctrl', 'Alt', 'Shift'] as const) {
    if (rest.startsWith(`${modifier}+`) && rest.length > modifier.length + 1) {
      used.push(modifier);
      rest = rest.slice(modifier.length + 1);
    }
  }
  if (NAMED_KEY.has(rest)) return true;
  if ([...rest].length !== 1 || used.includes('Shift')) return false;
  if (/[\s\p{Cc}\p{Cf}\p{Cs}]/u.test(rest)) return false;
  return used.length === 0 || rest.toLowerCase() === rest;
}

function checkNames(check: FileChecker, value: unknown): NamesSettings | undefined {
  if (!isTable(value)) {
    check.report('warning', 'invalid-type', ['names'], '[names] must be a table');
    return undefined;
  }
  let enabled: boolean | undefined;
  let key: string | undefined;
  let languages: string[] | undefined;
  let maxFileBytes: number | undefined;
  for (const name of sortedKeys(value)) {
    const path = ['names', name];
    const entry = value[name];
    switch (name) {
      case 'enabled':
        if (typeof entry === 'boolean') enabled = entry;
        else check.report('warning', 'invalid-type', path, 'enabled must be true or false');
        break;
      case 'key':
        if (typeof entry !== 'string') check.report('warning', 'invalid-type', path, 'key must be a string');
        else if (!namesKeyOk(entry)) {
          check.report('warning', 'invalid-value', path, `key "${entry}" is not a canonical key; skipped`);
        } else key = entry;
        break;
      case 'languages':
        if (!Array.isArray(entry)) {
          check.report('warning', 'invalid-type', path, 'languages must be a list of language names');
          break;
        }
        languages = [];
        for (const item of entry) {
          if (typeof item !== 'string' || !NAME_LANG.has(item)) {
            check.report(
              'warning',
              'invalid-value',
              path,
              'languages must list rust, typescript, javascript, python or go; entry skipped',
            );
          } else if (!languages.includes(item)) languages.push(item);
        }
        break;
      case 'maxFileBytes':
        if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1 || entry > 1_048_576) {
          check.report('warning', 'invalid-value', path, 'maxFileBytes must be an integer from 1 to 1048576');
        } else maxFileBytes = entry;
        break;
      default:
        check.unknown(path, `"${name}" in [names]`);
    }
  }
  if (enabled === undefined && key === undefined && languages === undefined && maxFileBytes === undefined) {
    return undefined;
  }
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(key === undefined ? {} : { key }),
    ...(languages === undefined ? {} : { languages }),
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
  };
}

function checkSwitch(check: FileChecker, value: unknown, table: string, name: string): boolean | undefined {
  if (!isTable(value)) {
    check.report('warning', 'invalid-type', [table], `[${table}] must be a table`);
    return undefined;
  }
  let result: boolean | undefined;
  for (const key of sortedKeys(value)) {
    if (key !== name) {
      check.unknown([table, key], `"${key}" in [${table}]`);
      continue;
    }
    const flag = value[key];
    if (typeof flag === 'boolean') result = flag;
    else check.report('warning', 'invalid-type', [table, key], `${name} must be true or false`);
  }
  return result;
}

function checkEvents(
  check: FileChecker,
  value: unknown,
): { enabled: boolean | undefined; failOpen: boolean | undefined } {
  if (!isTable(value)) {
    check.report('warning', 'invalid-type', ['events'], '[events] must be a table');
    return { enabled: undefined, failOpen: undefined };
  }
  let enabled: boolean | undefined;
  let failOpen: boolean | undefined;
  for (const key of sortedKeys(value)) {
    if (key === 'enabled') {
      const flag = value[key];
      if (typeof flag === 'boolean') enabled = flag;
      else check.report('warning', 'invalid-type', ['events', key], 'enabled must be true or false');
    } else if (key === 'failOpen') {
      const flag = value[key];
      if (typeof flag === 'boolean') failOpen = flag;
      else check.report('warning', 'invalid-type', ['events', key], 'failOpen must be true or false');
    } else check.unknown(['events', key], `"${key}" in [events]`);
  }
  return { enabled, failOpen };
}

function checkPlugins(
  check: FileChecker,
  value: unknown,
): { order: string[] | undefined; tables: Record<string, PluginTable> } {
  const tables: Record<string, PluginTable> = {};
  if (!isTable(value)) {
    check.report('warning', 'invalid-type', ['plugins'], '[plugins] must be a table');
    return { order: undefined, tables };
  }
  let order: string[] | undefined;
  for (const key of sortedKeys(value)) {
    const entry = value[key];
    if (key === 'order') {
      if (!Array.isArray(entry)) {
        check.report('warning', 'invalid-type', ['plugins', key], 'order must be a list of plugin names');
        continue;
      }
      order = [];
      for (const id of entry) {
        if (typeof id !== 'string' || !PLUGIN_ID.test(id)) {
          check.report('warning', 'invalid-value', ['plugins', key], 'order must list plugin names; entry skipped');
        } else if (order.includes(id)) {
          check.report('warning', 'invalid-value', ['plugins', key], `plugin "${id}" is listed twice; kept the first`);
        } else order.push(id);
      }
      continue;
    }
    const path = ['plugins', key];
    if (!PLUGIN_ID.test(key)) {
      check.report('warning', 'invalid-value', path, `"${key}" is not a plugin name; ignored`);
      continue;
    }
    if (!isTable(entry)) {
      check.report('warning', 'invalid-type', path, `[plugins.${key}] must be a table`);
      continue;
    }
    let enabled: boolean | undefined;
    const settings: Record<string, JsonValue> = {};
    for (const name of sortedKeys(entry)) {
      const setting = entry[name];
      if (name === 'enabled') {
        if (typeof setting === 'boolean') enabled = setting;
        else check.report('warning', 'invalid-type', [...path, name], 'enabled must be true or false');
        continue;
      }
      const json = toJson(setting);
      if (json === undefined) {
        check.report(
          'warning',
          'invalid-value',
          [...path, name],
          `setting "${name}" of plugin "${key}" is not JSON data (a date, or a number that is not finite or not below 2^53); skipped`,
        );
      } else {
        put(settings, name, json);
      }
    }
    put(tables, key, { ...(enabled === undefined ? {} : { enabled }), settings, at: check.at(path) });
  }
  return { order, tables };
}

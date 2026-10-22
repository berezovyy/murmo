// Manifest v1 (`murmo.plugin.json`), the API range grammar, the settings-schema
// subset and capability negotiation. This is the preflight every loader runs
// before any plugin code: devkit, `murmo plugin`, the core and the helper call the
// same functions, so a plugin is admitted or refused the same way on Node, Bun
// and both QuickJS engines (lesson 73). Portable: no Node APIs, no structuredClone,
// no Object.hasOwn (QuickJS and the Claude runtime are targets).

import { CAPABILITY_PATHS, type Capabilities } from './caps.ts';
import { EVENTS_VERSION } from './events.ts';
import { API_DRAFT, API_VERSION, EVENT_PERMISSIONS, LIMITS, PERMISSIONS, type Permission } from './limits.ts';

/** File name of the manifest inside a plugin package. */
export const MANIFEST_FILE = 'murmo.plugin.json';

export type CapabilityRequirement = boolean | string | readonly string[];

export interface SettingsProperty {
  readonly type: 'string' | 'boolean' | 'number' | 'integer';
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly default?: string | number | boolean;
  /** Numbers and integers only. */
  readonly minimum?: number;
  readonly maximum?: number;
  /** Strings only, in UTF-16 units. */
  readonly maxLength?: number;
}

/** A deliberately bounded JSON Schema subset; any other keyword is refused. */
export interface SettingsSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, SettingsProperty>>;
  readonly required?: readonly string[];
  /** Unknown settings are refused unless this is `true`. */
  readonly additionalProperties?: boolean;
}

export interface PermissionDeclaration {
  readonly name: Permission;
  /** Shown to the user when the host asks for the grant. */
  readonly reason: string;
}

/**
 * Manifest v1. `api` names the core contract, independently of the plugin's own
 * `version`. There is no `builtin` field: built-in trust comes from the host
 * that installs a plugin, never from the plugin's files.
 */
export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly api: string;
  /** Events API range (`^0.4.0`). Required when declaring an event permission. */
  readonly events?: string;
  readonly entry: string;
  readonly permissions: readonly PermissionDeclaration[];
  readonly capabilities: {
    readonly required: Readonly<Record<string, CapabilityRequirement>>;
    readonly optional: Readonly<Record<string, CapabilityRequirement>>;
  };
  readonly settingsSchema: SettingsSchema;
  /** Requested guest memory ceiling; above `LIMITS.defaultMemoryMiB` needs reviewed admission. */
  readonly resources?: { readonly memoryMiB: number };
}

/** The outcome of negotiation, handed to the plugin as `ctx.negotiation`. */
export interface Negotiation {
  readonly apiVersion: string;
  readonly apiDraft: string;
  /** Every optional path the manifest asked for, and whether this host meets it. */
  readonly optional: Readonly<Record<string, boolean>>;
  readonly missingOptional: readonly string[];
}

/**
 * Core feature paths (`api.<feature>`), with the API version that introduced each.
 * They describe what the core implements, not what the host supports.
 */
export const API_FEATURES = {
  'typed-read-default': '2.0.0',
  'submit-observe': '2.0.0',
  'attributed-edits': '2.0.0',
  'adaptive-budgets': '2.0.0',
} as const;

export type ManifestErrorCode =
  | 'too-large'
  | 'invalid-json'
  | 'not-object'
  | 'missing-field'
  | 'unknown-field'
  | 'builtin-field'
  | 'invalid-name'
  | 'invalid-version'
  | 'invalid-range'
  | 'invalid-entry'
  | 'invalid-permissions'
  | 'invalid-capabilities'
  | 'invalid-resources'
  | 'invalid-settings-schema'
  | 'invalid-setting'
  | 'api-mismatch'
  | 'capability-unknown'
  | 'capability-unavailable';

/** Every refusal names a code and the manifest path it is about, e.g. `permissions[1].reason`. */
export class ManifestError extends Error {
  declare readonly code: ManifestErrorCode;
  declare readonly path: string;

  constructor(code: ManifestErrorCode, path: string, message: string) {
    super(`manifest: ${message}`);
    this.name = 'ManifestError';
    this.code = code;
    this.path = path;
  }
}

const REQUIRED_FIELDS = ['name', 'version', 'api', 'entry', 'permissions', 'capabilities', 'settingsSchema'] as const;
const TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set<string>([...REQUIRED_FIELDS, 'resources', 'events']);
const EVENT_PERMISSION_NAMES: ReadonlySet<string> = new Set(EVENT_PERMISSIONS);
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set(['type', 'properties', 'required', 'additionalProperties']);
const PROPERTY_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'description',
  'enum',
  'default',
  'minimum',
  'maximum',
  'maxLength',
]);
const SCALAR_TYPES: ReadonlySet<string> = new Set(['string', 'boolean', 'number', 'integer']);
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);
const PERMISSION_NAMES: ReadonlySet<string> = new Set(PERMISSIONS);
const KNOWN_PATHS: ReadonlySet<string> = new Set(CAPABILITY_PATHS);

const NAME = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]{0,63}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RANGE_TOKEN = /^(\^|~|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/;
const CAPABILITY_PATH = /^[a-zA-Z][\w-]*(?:\.[a-zA-Z][\w-]*)*$/;
const MAX_RANGE_LENGTH = 256;

type Version = readonly [major: number, minor: number, patch: number];

/**
 * Parses `murmo.plugin.json` text: at most `LIMITS.manifestBytes` of UTF-8, then
 * JSON, then `validateManifest`.
 */
export function parseManifest(text: string): PluginManifest {
  if (typeof text !== 'string') throw new ManifestError('invalid-json', '', 'manifest text must be a string');
  const bytes = utf8Length(text);
  if (bytes > LIMITS.manifestBytes) {
    throw new ManifestError('too-large', '', `manifest is ${bytes} bytes; the limit is ${LIMITS.manifestBytes}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ManifestError('invalid-json', '', `not valid JSON (${(error as Error).message})`);
  }
  return validateManifest(value);
}

/** Checks every manifest rule and returns a detached copy. Throws `ManifestError`. */
export function validateManifest(value: unknown): PluginManifest {
  if (!isPlainObject(value)) throw new ManifestError('not-object', '', 'expected a JSON object');
  for (const key of Object.keys(value)) {
    if (key === 'builtin') {
      throw new ManifestError(
        'builtin-field',
        'builtin',
        'a manifest cannot declare builtin: built-in trust is set by the host that installs the plugin',
      );
    }
    if (!TOP_LEVEL_FIELDS.has(key)) throw new ManifestError('unknown-field', key, `unknown field "${key}"`);
  }
  for (const key of REQUIRED_FIELDS) {
    if (!own(value, key)) throw new ManifestError('missing-field', key, `missing required field "${key}"`);
  }
  const m = value as Record<string, unknown>;
  if (typeof m.name !== 'string' || !NAME.test(m.name)) {
    throw new ManifestError('invalid-name', 'name', 'name must be a lowercase npm-style name, optionally scoped');
  }
  checkPluginVersion(m.version);
  checkRange(m.api, 'api');
  if (own(m, 'events')) checkRange(m.events, 'events');
  checkEntry(m.entry);
  checkPermissions(m.permissions, own(m, 'events'));
  checkCapabilities(m.capabilities);
  checkSettingsSchema(m.settingsSchema);
  if (own(m, 'resources')) checkResources(m.resources);
  return JSON.parse(JSON.stringify(m)) as PluginManifest;
}

/**
 * True when the stable version `core` is inside `range`. The grammar is strict:
 * exact `2.0.0`, `^2.0.0`, `~2.0.0`, comparators (`>=`, `<=`, `>`, `<`, `=`)
 * combined by spaces (AND) and `||` (OR). Wildcards, partial versions, hyphen
 * ranges and prereleases are an error, never an optimistic match. Caret bounds
 * follow semver for major zero: `^0.2.3` stops before `0.3.0`.
 */
export function satisfies(core: string, range: string): boolean {
  const current = parseVersion(core, 'core');
  return checkRange(range, 'api').some((alternative) =>
    alternative.every(([op, base]) => compareTo(op, compareVersions(current, base), current, base)),
  );
}

/** Parses a stable `MAJOR.MINOR.PATCH` version without leading zeros. */
export function parseVersion(text: unknown, path = 'version'): Version {
  if (typeof text !== 'string' || !STABLE_VERSION.test(text)) {
    throw new ManifestError('invalid-version', path, `expected a stable MAJOR.MINOR.PATCH version, got ${show(text)}`);
  }
  const parts = text.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new ManifestError('invalid-version', path, 'version part too large');
  return [parts[0] as number, parts[1] as number, parts[2] as number];
}

/** Semver precedence of two stable versions: negative, zero or positive. */
export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Settings for the factory: user `input` checked against the schema, defaults
 * filled in for absent keys, required keys enforced. Throws `ManifestError`.
 */
export function resolveSettings(
  manifest: PluginManifest,
  input: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  if (!isPlainObject(input)) throw new ManifestError('invalid-setting', 'settings', 'settings must be an object');
  const schema = manifest.settingsSchema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const property = own(schema.properties, key) ? schema.properties[key] : undefined;
    if (property) {
      checkSettingValue(key, value, property, `settings.${key}`);
    } else if (schema.additionalProperties !== true) {
      throw new ManifestError('invalid-setting', `settings.${key}`, `unknown setting "${key}"`);
    } else if (!isJsonValue(value, 0)) {
      throw new ManifestError('invalid-setting', `settings.${key}`, `setting "${key}" must be JSON data`);
    }
    defineValue(out, key, value);
  }
  for (const [key, property] of Object.entries(schema.properties)) {
    if (!own(out, key) && property.default !== undefined) defineValue(out, key, property.default);
  }
  for (const key of schema.required ?? []) {
    if (!own(out, key)) throw new ManifestError('invalid-setting', `settings.${key}`, `missing setting "${key}"`);
  }
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

/**
 * Checks the manifest's `api` range against `core` and its capability
 * requirements against the host's measured `caps`. A missing required capability
 * refuses the plugin; a missing optional one is reported, never invented.
 * Booleans and strings must be equal; a string array must be a subset.
 */
export function negotiate(manifest: PluginManifest, caps: Capabilities, core: string = API_VERSION): Negotiation {
  const m = validateManifest(manifest);
  if (!satisfies(core, m.api)) {
    const legacy = checkRange(m.api, 'api').every((alternative) => alternative.some(([, base]) => base[0] < 2));
    throw new ManifestError(
      'api-mismatch',
      'api',
      `${m.name} targets API ${m.api}; this core implements ${core} (draft ${API_DRAFT})` +
        (legacy ? '. API 2.0 is breaking: rewrite the plugin for ^2.0.0' : ''),
    );
  }
  if (m.events && !satisfies(EVENTS_VERSION, m.events)) {
    throw new ManifestError(
      'api-mismatch',
      'events',
      `${m.name} targets events ${m.events}; this core implements ${EVENTS_VERSION}`,
    );
  }
  const unknown: string[] = [];
  const unavailable: string[] = [];
  for (const [path, expected] of Object.entries(m.capabilities.required)) {
    const verdict = meets(path, expected, caps, core);
    if (verdict === 'unknown') unknown.push(path);
    else if (verdict === 'unmet') unavailable.push(path);
  }
  if (unknown.length) {
    throw new ManifestError(
      'capability-unknown',
      `capabilities.required.${unknown[0]}`,
      `${m.name} requires capabilities API ${core} does not define: ${unknown.join(', ')}`,
    );
  }
  if (unavailable.length) {
    throw new ManifestError(
      'capability-unavailable',
      `capabilities.required.${unavailable[0]}`,
      `${m.name} requires capabilities this host lacks: ${unavailable.join(', ')}`,
    );
  }
  const optional: Record<string, boolean> = {};
  for (const [path, expected] of Object.entries(m.capabilities.optional)) {
    defineValue(optional, path, meets(path, expected, caps, core) === 'met');
  }
  return {
    apiVersion: core,
    apiDraft: API_DRAFT,
    optional,
    missingOptional: Object.keys(optional).filter((path) => !optional[path]),
  };
}

type Comparator = readonly [op: string, base: Version];

function checkRange(range: unknown, path: string): Comparator[][] {
  if (typeof range !== 'string' || !range.trim() || range.length > MAX_RANGE_LENGTH) {
    throw new ManifestError(
      'invalid-range',
      path,
      `api range must be a nonempty string of at most ${MAX_RANGE_LENGTH}`,
    );
  }
  return range
    .trim()
    .split('||')
    .map((alternative) => {
      const tokens = alternative.trim().split(/\s+/);
      if (!alternative.trim())
        throw new ManifestError('invalid-range', path, `empty alternative in range ${show(range)}`);
      return tokens.map((token): Comparator => {
        const match = RANGE_TOKEN.exec(token);
        if (!match?.[2] || !STABLE_VERSION.test(match[2])) {
          throw new ManifestError(
            'invalid-range',
            path,
            `unsupported range token ${show(token)}: use exact, ^, ~, comparators and ||`,
          );
        }
        return [match[1] ?? '=', parseVersion(match[2], path)];
      });
    });
}

function compareTo(op: string, order: number, current: Version, base: Version): boolean {
  switch (op) {
    case '^': {
      const upper: Version =
        base[0] > 0 ? [base[0] + 1, 0, 0] : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
      return order >= 0 && compareVersions(current, upper) < 0;
    }
    case '~':
      return order >= 0 && compareVersions(current, [base[0], base[1] + 1, 0]) < 0;
    case '>=':
      return order >= 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '<':
      return order < 0;
    default:
      return order === 0;
  }
}

/**
 * Plugin versions are stable semver, like core versions: one ordering rule for
 * ranges, update checks and rollback high-water marks. A prerelease suffix is
 * refused (preview channels belong to the installer envelope).
 */
function checkPluginVersion(version: unknown): void {
  if (typeof version === 'string' && /^\d+\.\d+\.\d+-/.test(version)) {
    throw new ManifestError(
      'invalid-version',
      'version',
      `plugin version ${show(version)} has a prerelease suffix; plugin versions are stable MAJOR.MINOR.PATCH`,
    );
  }
  parseVersion(version, 'version');
}

function checkEntry(entry: unknown): void {
  const inside =
    typeof entry === 'string' &&
    entry.endsWith('.mjs') &&
    !entry.startsWith('/') &&
    !/^[A-Za-z]:/.test(entry) &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
    !/[\\\u0000-\u001f\u007f]/.test(entry) &&
    entry.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  if (!inside)
    throw new ManifestError('invalid-entry', 'entry', 'entry must be a relative .mjs path inside the package');
}

function checkPermissions(value: unknown, hasEventsRange: boolean): void {
  if (!Array.isArray(value))
    throw new ManifestError('invalid-permissions', 'permissions', 'permissions must be an array');
  const seen = new Set<string>();
  value.forEach((declaration: unknown, index) => {
    const path = `permissions[${index}]`;
    if (!isPlainObject(declaration) || Object.keys(declaration).some((key) => key !== 'name' && key !== 'reason')) {
      throw new ManifestError('invalid-permissions', path, 'a permission is {"name", "reason"}');
    }
    const { name, reason } = declaration as { name?: unknown; reason?: unknown };
    if (typeof name !== 'string' || !PERMISSION_NAMES.has(name)) {
      throw new ManifestError('invalid-permissions', `${path}.name`, `unknown permission ${show(name)}`);
    }
    if (EVENT_PERMISSION_NAMES.has(name) && !hasEventsRange) {
      throw new ManifestError(
        'invalid-permissions',
        `${path}.name`,
        `permission "${name}" needs an events range (events API ${EVENTS_VERSION})`,
      );
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new ManifestError('invalid-permissions', `${path}.reason`, `permission "${name}" needs a reason`);
    }
    if (seen.has(name))
      throw new ManifestError('invalid-permissions', `${path}.name`, `duplicate permission "${name}"`);
    seen.add(name);
  });
}

function checkCapabilities(value: unknown): void {
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== 'required' && key !== 'optional')) {
    throw new ManifestError('invalid-capabilities', 'capabilities', 'capabilities must be {"required", "optional"}');
  }
  const seen = new Set<string>();
  for (const kind of ['required', 'optional'] as const) {
    const map = (value as Record<string, unknown>)[kind];
    if (!isPlainObject(map)) {
      throw new ManifestError('invalid-capabilities', `capabilities.${kind}`, `capabilities.${kind} must be a map`);
    }
    for (const [path, expected] of Object.entries(map)) {
      const at = `capabilities.${kind}.${path}`;
      if (!CAPABILITY_PATH.test(path) || path.split('.').some((part) => UNSAFE_KEYS.has(part))) {
        throw new ManifestError('invalid-capabilities', at, `invalid capability path ${show(path)}`);
      }
      const valid =
        typeof expected === 'boolean' ||
        typeof expected === 'string' ||
        (Array.isArray(expected) && expected.every((item) => typeof item === 'string'));
      if (!valid)
        throw new ManifestError('invalid-capabilities', at, 'a requirement is a boolean, string or string array');
      if (seen.has(path)) throw new ManifestError('invalid-capabilities', at, `${path} is both required and optional`);
      seen.add(path);
    }
  }
}

function checkResources(value: unknown): void {
  const memory = isPlainObject(value) ? (value as Record<string, unknown>).memoryMiB : undefined;
  const valid =
    isPlainObject(value) &&
    Object.keys(value).every((key) => key === 'memoryMiB') &&
    typeof memory === 'number' &&
    Number.isInteger(memory) &&
    memory >= 1 &&
    memory <= LIMITS.maxMemoryMiB;
  if (!valid) {
    throw new ManifestError('invalid-resources', 'resources', `resources is {"memoryMiB": 1..${LIMITS.maxMemoryMiB}}`);
  }
}

function checkSettingsSchema(schema: unknown): void {
  const path = 'settingsSchema';
  if (!isPlainObject(schema))
    throw new ManifestError('invalid-settings-schema', path, 'settingsSchema must be an object');
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) {
      throw new ManifestError('invalid-settings-schema', `${path}.${key}`, `unsupported schema keyword "${key}"`);
    }
  }
  const s = schema as Record<string, unknown>;
  if (s.type !== 'object' || !isPlainObject(s.properties)) {
    throw new ManifestError(
      'invalid-settings-schema',
      path,
      'settingsSchema is {"type": "object", "properties": {...}}',
    );
  }
  const properties = s.properties as Record<string, unknown>;
  if (own(s, 'additionalProperties') && typeof s.additionalProperties !== 'boolean') {
    throw new ManifestError('invalid-settings-schema', `${path}.additionalProperties`, 'must be a boolean');
  }
  if (own(s, 'required')) {
    const required = s.required;
    if (!Array.isArray(required) || required.some((key) => typeof key !== 'string' || !own(properties, key))) {
      throw new ManifestError('invalid-settings-schema', `${path}.required`, 'required must list declared properties');
    }
  }
  for (const [key, property] of Object.entries(properties)) {
    checkSettingsProperty(key, property, `${path}.properties.${key}`);
  }
}

function checkSettingsProperty(key: string, value: unknown, path: string): void {
  const fail = (message: string): never => {
    throw new ManifestError('invalid-settings-schema', path, `setting "${key}": ${message}`);
  };
  if (UNSAFE_KEYS.has(key)) fail('reserved name');
  if (!isPlainObject(value)) fail('must be an object');
  const p = value as Record<string, unknown>;
  for (const keyword of Object.keys(p)) if (!PROPERTY_KEYWORDS.has(keyword)) fail(`unsupported keyword "${keyword}"`);
  if (typeof p.type !== 'string' || !SCALAR_TYPES.has(p.type)) fail('type must be string, boolean, number or integer');
  const numeric = p.type === 'number' || p.type === 'integer';
  if (own(p, 'description') && typeof p.description !== 'string') fail('description must be a string');
  for (const bound of ['minimum', 'maximum'] as const) {
    if (!own(p, bound)) continue;
    if (!numeric) fail(`${bound} applies to numbers only`);
    if (typeof p[bound] !== 'number' || !Number.isFinite(p[bound])) fail(`${bound} must be a finite number`);
  }
  if (own(p, 'minimum') && own(p, 'maximum') && (p.minimum as number) > (p.maximum as number)) {
    fail('minimum is above maximum');
  }
  if (own(p, 'maxLength')) {
    if (p.type !== 'string') fail('maxLength applies to strings only');
    if (!Number.isInteger(p.maxLength) || (p.maxLength as number) < 0) fail('maxLength must be a nonnegative integer');
  }
  if (own(p, 'enum') && (!Array.isArray(p.enum) || p.enum.length === 0)) fail('enum must be a nonempty array');
  const property = p as unknown as SettingsProperty;
  for (const allowed of property.enum ?? []) checkSettingValue(key, allowed, property, path, false);
  if (own(p, 'default')) checkSettingValue(key, p.default, property, `${path}.default`);
}

function checkSettingValue(key: string, value: unknown, property: SettingsProperty, path: string, inEnum = true): void {
  const fail = (message: string): never => {
    throw new ManifestError('invalid-setting', path, `setting "${key}" ${message}`);
  };
  const typed =
    property.type === 'integer'
      ? typeof value === 'number' && Number.isInteger(value)
      : typeof value === property.type && (typeof value !== 'number' || Number.isFinite(value));
  if (!typed) fail(`must be ${property.type === 'integer' ? 'an integer' : `a ${property.type}`}`);
  if (inEnum && property.enum && !property.enum.some((allowed) => allowed === value)) fail('is outside its enum');
  if (typeof value === 'number') {
    if (property.minimum !== undefined && value < property.minimum) fail(`is below ${property.minimum}`);
    if (property.maximum !== undefined && value > property.maximum) fail(`is above ${property.maximum}`);
  }
  if (typeof value === 'string' && property.maxLength !== undefined && value.length > property.maxLength) {
    fail(`exceeds ${property.maxLength} UTF-16 units`);
  }
}

type Verdict = 'met' | 'unmet' | 'unknown';

function meets(path: string, expected: CapabilityRequirement, caps: Capabilities, core: string): Verdict {
  if (path.startsWith('api.')) {
    const feature = path.slice(4);
    if (!own(API_FEATURES, feature)) return 'unknown';
    const since = API_FEATURES[feature as keyof typeof API_FEATURES];
    return satisfies(core, `>=${since}`) === expected ? 'met' : 'unmet';
  }
  if (!KNOWN_PATHS.has(path)) return 'unknown';
  let actual: unknown = caps;
  for (const part of path.split('.')) {
    actual = isPlainObject(actual) && own(actual, part) ? (actual as Record<string, unknown>)[part] : undefined;
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((item) => actual.includes(item)) ? 'met' : 'unmet';
  }
  return actual === expected ? 'met' : 'unmet';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // Accept plain objects from any realm (a helper or vm context may build them).
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isPlainObject(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function own(object: object, key: string): boolean {
  return Object.hasOwn(object, key);
}

// A plain assignment to "__proto__" would change the prototype instead of adding a key.
function defineValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function show(value: unknown): string {
  return typeof value === 'string'
    ? JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}...` : value)
    : String(value);
}

/** UTF-8 length of a JS string; a lone surrogate counts as U+FFFD (3 bytes), as encoders write it. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

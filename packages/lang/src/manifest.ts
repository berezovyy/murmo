// The language-pack manifest (`murmo-language-pack/v1`): what a pack ships and
// the hashes that bind its files together. The inline registration (docs/plan/07)
// refers to the table through this manifest, and every later language follows
// the same shape (README.md, "Manifest"). Parsing is strict: an unknown kind or
// format disables correction with a reason instead of guessing.

import { TABLE_FORMAT } from './table.ts';

export const PACK_KIND = 'murmo-language-pack/v1';
export const CASE_POLICY_FORMAT = 'murmo-case-policy/v1';
export const PROVENANCE_FORMAT = 'murmo-provenance-csv/v1';
/** Claude's `$.fs` reads at most 4 MiB at once (docs/plan/26); a table must fit one read. */
export const MAX_TABLE_BYTES = 4 * 1024 * 1024;

export interface PackFile {
  /** Path relative to the pack directory, `/`-separated, no `..`. */
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface PackTableFile extends PackFile {
  readonly format: typeof TABLE_FORMAT;
  readonly entries: number;
}

export interface PackLicense extends PackFile {
  /** What the notice covers, for people reading the manifest. */
  readonly covers: string;
}

/** One pinned build input, recorded so a pack can be traced to exact bytes. */
export interface SourcePin {
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
  readonly license: string;
  /** `correction-source` inputs supply typo→word pairs; every other role only removes or ranks them. */
  readonly role: 'correction-source' | 'guard' | 'review' | 'policy';
  readonly url?: string;
}

export interface LanguagePackManifest {
  readonly kind: typeof PACK_KIND;
  /** BCP 47 language tag the pack corrects, e.g. `en`. */
  readonly language: string;
  /** Name of the data policy that chose the entries, e.g. `strict-common-v1`. */
  readonly policy: string;
  readonly table: PackTableFile;
  /** Keys whose case rules the packed bytes cannot carry (r8: `teh`, `adn`, `thier` are lowercase-only). */
  readonly casePolicy: PackFile & { readonly format: typeof CASE_POLICY_FORMAT };
  /** One row per entry source: SCOWL file and line, or authored-list line. */
  readonly provenance: PackFile & { readonly format: typeof PROVENANCE_FORMAT; readonly rows: number };
  readonly notice: PackFile;
  readonly licenses: readonly PackLicense[];
  readonly sources: readonly SourcePin[];
  readonly build: { readonly tool: string; readonly version: string };
}

export class ManifestError extends Error {
  /** `unknown-format` for a kind or format this runtime does not know; `invalid` for anything malformed. */
  readonly code: 'unknown-format' | 'invalid';
  constructor(code: 'unknown-format' | 'invalid', message: string) {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
  }
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256Pattern = /^[0-9a-f]{64}$/;
const tagPattern = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const namePattern = /^[a-z0-9][a-z0-9.-]*$/;

function fail(message: string): never {
  throw new ManifestError('invalid', `language pack manifest: ${message}`);
}

function string(o: Json, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) fail(`${where}.${key} must be a non-empty string`);
  return v;
}

function count(o: Json, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(`${where}.${key} must be a whole number`);
  return v;
}

function file(v: unknown, where: string): PackFile {
  if (!isObject(v)) fail(`${where} must be an object`);
  const path = string(v, 'file', where);
  const segments = path.split('/');
  if (path.startsWith('/') || segments.some((s) => s === '' || s === '.' || s === '..') || path.includes('\\')) {
    fail(`${where}.file "${path}" must be a relative path inside the pack`);
  }
  const sha256 = string(v, 'sha256', where);
  if (!sha256Pattern.test(sha256)) fail(`${where}.sha256 must be 64 lowercase hex digits`);
  return { file: path, sha256, bytes: count(v, 'bytes', where) };
}

const roles = new Set(['correction-source', 'guard', 'review', 'policy']);

/** Checks a parsed manifest; throws `ManifestError`. Unknown fields are refused, so a typo can't hide a field. */
export function parseManifest(json: unknown): LanguagePackManifest {
  if (!isObject(json)) fail('must be a JSON object');
  if (json.kind !== PACK_KIND) {
    throw new ManifestError('unknown-format', `language pack kind ${JSON.stringify(json.kind)} is not ${PACK_KIND}`);
  }
  const known = [
    'kind',
    'language',
    'policy',
    'table',
    'casePolicy',
    'provenance',
    'notice',
    'licenses',
    'sources',
    'build',
  ];
  for (const key of Object.keys(json)) if (!known.includes(key)) fail(`unknown field "${key}"`);
  const language = string(json, 'language', 'manifest');
  if (!tagPattern.test(language)) fail(`language "${language}" is not a language tag`);
  const policy = string(json, 'policy', 'manifest');
  if (!namePattern.test(policy)) fail(`policy "${policy}" is not a policy name`);

  const tableJson = json.table;
  const table = file(tableJson, 'table');
  const tableFormat = (tableJson as Json).format;
  if (tableFormat !== TABLE_FORMAT) {
    throw new ManifestError('unknown-format', `table format ${JSON.stringify(tableFormat)} is not ${TABLE_FORMAT}`);
  }
  if (table.bytes > MAX_TABLE_BYTES) fail(`table is ${table.bytes} bytes, over the ${MAX_TABLE_BYTES}-byte limit`);
  const entries = count(tableJson as Json, 'entries', 'table');

  const caseJson = json.casePolicy;
  const casePolicy = file(caseJson, 'casePolicy');
  const caseFormat = (caseJson as Json).format;
  if (caseFormat !== CASE_POLICY_FORMAT) {
    throw new ManifestError(
      'unknown-format',
      `case policy format ${JSON.stringify(caseFormat)} is not ${CASE_POLICY_FORMAT}`,
    );
  }

  const provenanceJson = json.provenance;
  const provenance = file(provenanceJson, 'provenance');
  if ((provenanceJson as Json).format !== PROVENANCE_FORMAT) fail(`provenance.format must be ${PROVENANCE_FORMAT}`);
  const rows = count(provenanceJson as Json, 'rows', 'provenance');
  if (rows < entries) fail(`provenance has ${rows} rows for ${entries} entries`);

  const notice = file(json.notice, 'notice');
  if (!Array.isArray(json.licenses) || json.licenses.length === 0) fail('licenses must list at least one notice');
  const licenses = json.licenses.map((l, i) => ({
    ...file(l, `licenses[${i}]`),
    covers: string(l as Json, 'covers', `licenses[${i}]`),
  }));
  if (!Array.isArray(json.sources) || json.sources.length === 0) fail('sources must list the pinned build inputs');
  const sources = json.sources.map((s, i): SourcePin => {
    const where = `sources[${i}]`;
    if (!isObject(s)) fail(`${where} must be an object`);
    const sha256 = string(s, 'sha256', where);
    if (!sha256Pattern.test(sha256)) fail(`${where}.sha256 must be 64 lowercase hex digits`);
    const role = string(s, 'role', where);
    if (!roles.has(role)) fail(`${where}.role "${role}" is unknown`);
    const pin: SourcePin = {
      name: string(s, 'name', where),
      version: string(s, 'version', where),
      sha256,
      license: string(s, 'license', where),
      role: role as SourcePin['role'],
    };
    return s.url === undefined ? pin : { ...pin, url: string(s, 'url', where) };
  });
  const buildJson = json.build;
  if (!isObject(buildJson)) fail('build must be an object');

  const files = [table, casePolicy, provenance, notice, ...licenses].map((f) => f.file);
  if (new Set(files).size !== files.length) fail('two entries name the same file');

  return {
    kind: PACK_KIND,
    language,
    policy,
    table: { ...table, format: TABLE_FORMAT, entries },
    casePolicy: { ...casePolicy, format: CASE_POLICY_FORMAT },
    provenance: { ...provenance, format: PROVENANCE_FORMAT, rows },
    notice,
    licenses,
    sources,
    build: { tool: string(buildJson, 'tool', 'build'), version: string(buildJson, 'version', 'build') },
  };
}

/** Every file a manifest names, table first. */
export function packFiles(manifest: LanguagePackManifest): readonly PackFile[] {
  return [manifest.table, manifest.casePolicy, manifest.provenance, manifest.notice, ...manifest.licenses];
}

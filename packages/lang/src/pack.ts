// Validating a language pack once, and opening it cheaply many times.
//
// Lesson 66: checking the hash and every entry costs 56–74 ms in Node and Bun
// and about 1.7 s in QuickJS, so full validation runs at build and at install
// (`murmo setup`, `murmo doctor`), and the install writes a record. A session
// then checks only sizes, mtimes, the header and that record, and maps the
// bytes without copying. Where the runtime has a fast native SHA-256 (Node and
// Bun crypto; Rust behind the Codex wrapper's trusted loader, docs/plan/23) the
// caller passes it and the table hash is checked too; where it has none
// (Claude's plugin realm) the record, sizes and mtimes are the check, and the
// result says so (`integrity`), for `murmo doctor` to report.

import { type CasePolicy, CasePolicyError, parseCasePolicy } from './case-policy.ts';
import { type LanguagePackManifest, ManifestError, packFiles, parseManifest } from './manifest.ts';
import { mapTable, type PackedTable, TableError, validateTable } from './table.ts';
import { decodeUtf8 } from './utf8.ts';

/** Lowercase hex SHA-256 of some bytes, from the runtime's native crypto. */
export type Sha256 = (bytes: Uint8Array) => string;

/** Bumped whenever validation checks more, so older install records stop counting. */
export const VALIDATOR = 'murmo-lang-validator/1';
export const RECORD_KIND = 'murmo-language-pack-validation/v1';

export type PackProblem =
  | 'missing-file'
  | 'manifest-invalid'
  | 'unknown-format'
  | 'not-validated'
  | 'record-stale'
  | 'size-mismatch'
  | 'table-invalid'
  | 'hash-mismatch'
  | 'case-policy-invalid';

export class PackError extends Error {
  readonly problem: PackProblem;
  constructor(problem: PackProblem, message: string) {
    super(message);
    this.name = 'PackError';
    this.problem = problem;
  }
}

/** A pack that is ready for lookups. */
export interface LanguagePack {
  readonly manifest: LanguagePackManifest;
  readonly table: PackedTable;
  readonly casePolicy: CasePolicy;
}

/** What full validation proved; the install record stores it. */
export interface ValidationReceipt {
  readonly validator: typeof VALIDATOR;
  readonly language: string;
  readonly policy: string;
  readonly table: { readonly sha256: string; readonly bytes: number; readonly entries: number };
  readonly casePolicy: { readonly sha256: string; readonly bytes: number };
  /** Every file the manifest names, by path. */
  readonly files: Readonly<Record<string, { readonly sha256: string; readonly bytes: number }>>;
}

function parseJsonFile(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    throw new PackError(what === 'manifest' ? 'manifest-invalid' : 'case-policy-invalid', `${what}: ${message(error)}`);
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function manifestOf(bytes: Uint8Array): LanguagePackManifest {
  const json = parseJsonFile(bytes, 'manifest');
  try {
    return parseManifest(json);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new PackError(error.code === 'unknown-format' ? 'unknown-format' : 'manifest-invalid', error.message);
    }
    throw error;
  }
}

function tableOf(bytes: Uint8Array, manifest: LanguagePackManifest): PackedTable {
  if (bytes.byteLength !== manifest.table.bytes) {
    throw new PackError(
      'size-mismatch',
      `${manifest.table.file} is ${bytes.byteLength} bytes, manifest says ${manifest.table.bytes}`,
    );
  }
  let table: PackedTable;
  try {
    table = mapTable(bytes);
  } catch (error) {
    if (error instanceof TableError) {
      throw new PackError(
        error.code === 'unknown-format' ? 'unknown-format' : 'table-invalid',
        `${manifest.table.file}: ${error.message}`,
      );
    }
    throw error;
  }
  if (table.entries !== manifest.table.entries) {
    throw new PackError(
      'table-invalid',
      `${manifest.table.file} has ${table.entries} entries, manifest says ${manifest.table.entries}`,
    );
  }
  return table;
}

function casePolicyOf(bytes: Uint8Array, table: PackedTable): CasePolicy {
  try {
    return parseCasePolicy(parseJsonFile(bytes, 'case policy'), table);
  } catch (error) {
    if (error instanceof CasePolicyError) throw new PackError('case-policy-invalid', error.message);
    throw error;
  }
}

/**
 * Full validation, for build, install and doctor: the manifest, every file's
 * size and SHA-256, every table entry, and the case policy against the table.
 * `read` returns a file's bytes by its manifest path, or undefined.
 */
export function validatePack(
  manifestBytes: Uint8Array,
  read: (file: string) => Uint8Array | undefined,
  sha256: Sha256,
): ValidationReceipt {
  const manifest = manifestOf(manifestBytes);
  const files: Record<string, { sha256: string; bytes: number }> = {};
  const contents = new Map<string, Uint8Array>();
  for (const f of packFiles(manifest)) {
    const bytes = read(f.file);
    if (!bytes) {
      // provenance.csv is 8.6 MB and unused at runtime; the signed tarball omits it (docs/plan/26).
      if (f.file === manifest.provenance.file) continue;
      throw new PackError('missing-file', `${f.file} is missing`);
    }
    if (bytes.byteLength !== f.bytes) {
      throw new PackError('size-mismatch', `${f.file} is ${bytes.byteLength} bytes, manifest says ${f.bytes}`);
    }
    const digest = sha256(bytes);
    if (digest !== f.sha256)
      throw new PackError('hash-mismatch', `${f.file} has SHA-256 ${digest}, manifest says ${f.sha256}`);
    files[f.file] = { sha256: digest, bytes: bytes.byteLength };
    contents.set(f.file, bytes);
  }
  const table = tableOf(contents.get(manifest.table.file) as Uint8Array, manifest);
  try {
    validateTable(table);
  } catch (error) {
    if (error instanceof TableError) throw new PackError('table-invalid', `${manifest.table.file}: ${error.message}`);
    throw error;
  }
  casePolicyOf(contents.get(manifest.casePolicy.file) as Uint8Array, table);
  return {
    validator: VALIDATOR,
    language: manifest.language,
    policy: manifest.policy,
    table: { sha256: manifest.table.sha256, bytes: manifest.table.bytes, entries: manifest.table.entries },
    casePolicy: { sha256: manifest.casePolicy.sha256, bytes: manifest.casePolicy.bytes },
    files,
  };
}

/** The install record: a receipt plus what a session can check without hashing. */
export interface InstallRecord {
  readonly kind: typeof RECORD_KIND;
  readonly receipt: ValidationReceipt;
  /** Whole milliseconds, as every runtime's stat can report them. */
  readonly mtimeMs: { readonly manifest: number; readonly table: number; readonly casePolicy: number };
  readonly validatedAt: string;
}

export function installRecord(
  receipt: ValidationReceipt,
  mtimeMs: InstallRecord['mtimeMs'],
  validatedAt: string,
): InstallRecord {
  return { kind: RECORD_KIND, receipt, mtimeMs, validatedAt };
}

/** One file as a session reads it: its bytes and its modification time in whole milliseconds. */
export interface SessionFile {
  readonly bytes: Uint8Array;
  readonly mtimeMs: number;
}

export interface SessionFiles {
  readonly manifest: SessionFile;
  readonly table: SessionFile;
  readonly casePolicy: SessionFile;
  /** The install record's bytes, or undefined when there is none. */
  readonly record: Uint8Array | undefined;
}

export type OpenResult =
  | {
      readonly ok: true;
      readonly pack: LanguagePack;
      /** `sha256`: the table and case policy hashes were checked now; `install-record`: trusted from the record. */
      readonly integrity: 'sha256' | 'install-record';
    }
  | { readonly ok: false; readonly problem: PackProblem; readonly reason: string };

/**
 * Session start: no per-entry work. Fails closed with a reason, so a damaged,
 * changed or never-validated pack turns correction off and says why.
 */
export function openPack(files: SessionFiles, sha256?: Sha256): OpenResult {
  try {
    const manifest = manifestOf(files.manifest.bytes);
    const record = recordOf(files.record);
    checkRecord(record, manifest, files);
    const table = tableOf(files.table.bytes, manifest);
    if (files.casePolicy.bytes.byteLength !== manifest.casePolicy.bytes) {
      throw new PackError('size-mismatch', `${manifest.casePolicy.file} changed size since the manifest was written`);
    }
    if (sha256) {
      if (sha256(files.table.bytes) !== manifest.table.sha256) {
        throw new PackError('hash-mismatch', `${manifest.table.file} does not match its SHA-256`);
      }
      if (sha256(files.casePolicy.bytes) !== manifest.casePolicy.sha256) {
        throw new PackError('hash-mismatch', `${manifest.casePolicy.file} does not match its SHA-256`);
      }
    }
    const casePolicy = casePolicyOf(files.casePolicy.bytes, table);
    return { ok: true, pack: { manifest, table, casePolicy }, integrity: sha256 ? 'sha256' : 'install-record' };
  } catch (error) {
    if (error instanceof PackError) return { ok: false, problem: error.problem, reason: error.message };
    throw error;
  }
}

function recordOf(bytes: Uint8Array | undefined): InstallRecord {
  if (!bytes) throw new PackError('not-validated', 'the pack has no install record; run `murmo setup`');
  let json: unknown;
  try {
    json = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    throw new PackError('not-validated', `install record is unreadable: ${message(error)}`);
  }
  const r = json as Partial<InstallRecord> | null;
  if (!r || r.kind !== RECORD_KIND || !r.receipt || !r.mtimeMs) {
    throw new PackError('not-validated', 'install record has an unknown shape; run `murmo setup`');
  }
  return r as InstallRecord;
}

/**
 * The record must come from this validator and describe exactly the files on
 * disk: same table and case-policy hashes as the manifest (a string compare,
 * so a wrong manifest hash is caught even without native hashing), and same
 * sizes and mtimes as when it was validated.
 */
function checkRecord(record: InstallRecord, manifest: LanguagePackManifest, files: SessionFiles): void {
  const { receipt, mtimeMs } = record;
  const stale = (why: string) =>
    new PackError('record-stale', `${why} since \`murmo setup\` validated the pack; run it again`);
  if (receipt.validator !== VALIDATOR) throw stale(`the validator changed (${receipt.validator} → ${VALIDATOR})`);
  if (
    receipt.language !== manifest.language ||
    receipt.table?.sha256 !== manifest.table.sha256 ||
    receipt.table.bytes !== manifest.table.bytes ||
    receipt.table.entries !== manifest.table.entries ||
    receipt.casePolicy?.sha256 !== manifest.casePolicy.sha256 ||
    receipt.casePolicy.bytes !== manifest.casePolicy.bytes
  ) {
    throw stale('the manifest changed');
  }
  if (mtimeMs.manifest !== files.manifest.mtimeMs) throw stale('the manifest file was rewritten');
  if (mtimeMs.table !== files.table.mtimeMs || files.table.bytes.byteLength !== receipt.table.bytes) {
    throw stale(`${manifest.table.file} changed`);
  }
  if (mtimeMs.casePolicy !== files.casePolicy.mtimeMs) throw stale(`${manifest.casePolicy.file} changed`);
}

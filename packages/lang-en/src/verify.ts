// The independent verifier (round 7's verify.py and round 8's verify.mjs,
// r7 § 2). It shares no logic with generate.ts or authored.ts: it reads the
// built pack back through the runtime reader and checks every entry against
// its provenance and the pinned inputs by brute force, so a bug in the
// generator's deletion index or ranking can't vouch for itself.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyAt, lookup, mapTable, parseManifest, validatePack, valueAt } from '@murmo/lang';
import { defaultInputsDir, loadInputs, sha256 } from './inputs.ts';
import { buildLexicon, TARGET_MAX_LEVEL } from './lexicon.ts';
import { PACK_FILES, STRICT } from './policy.ts';
import { type ProvenanceRow, parseProvenance } from './provenance.ts';

/** Keys rounds 6, 7 and 13 found must never be corrected (real words, names, legacy raw-list pairs). */
export const MUST_BE_ABSENT = ['tme', 'fater', 'unparseable', 'ratatui', 'sur', 'inlining', 'inlines', 'aaccess'];

export interface VerifyReport {
  readonly entries: number;
  /** Two per entry (value matches its provenance; lookup returns it) plus the entry count and the absent keys. */
  readonly entryAssertions: number;
  readonly generatedRows: number;
  readonly authoredRows: number;
  readonly overrideRows: number;
  /** Generated keys checked by brute force for a different guard word one edit away. */
  readonly reverseChecks: number;
}

export class VerifyError extends Error {
  readonly failures: readonly string[];
  constructor(failures: readonly string[]) {
    super(
      `verification failed (${failures.length}${failures.length === MAX_FAILURES ? '+' : ''}):\n  ${failures.join('\n  ')}`,
    );
    this.name = 'VerifyError';
    this.failures = failures;
  }
}

const MAX_FAILURES = 50;
const alphabet = [...'abcdefghijklmnopqrstuvwxyz'];

/**
 * Brute force: the first string one insertion, deletion, substitution or
 * adjacent transposition from `w` that `hit` accepts, or undefined. Builds
 * every neighbor (about 54 per letter) instead of using an index.
 */
function findOneEdit(w: string, hit: (s: string) => boolean): string | undefined {
  for (let i = 0; i <= w.length; i++) {
    const head = w.slice(0, i);
    const tail = w.slice(i);
    for (const c of alphabet) if (hit(head + c + tail)) return head + c + tail;
  }
  for (let i = 0; i < w.length; i++) {
    const head = w.slice(0, i);
    const tail = w.slice(i + 1);
    if (hit(head + tail)) return head + tail;
    for (const c of alphabet) if (c !== w[i] && hit(head + c + tail)) return head + c + tail;
  }
  for (let i = 0; i < w.length - 1; i++) {
    const t = w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
    if (w[i] !== w[i + 1] && hit(t)) return t;
  }
  return undefined;
}

/** Damerau distance exactly one, by direct comparison. */
function isOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length !== b.length) {
    const [long, short] = a.length > b.length ? [a, b] : [b, a];
    return long.slice(i + 1) === short.slice(i);
  }
  if (a.slice(i + 1) === b.slice(i + 1)) return true;
  return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

export function verifyPack(packDir: string, inputsDir = defaultInputsDir): VerifyReport {
  const failures: string[] = [];
  const fail = (message: string) => {
    if (failures.length < MAX_FAILURES) failures.push(message);
  };
  const read = (file: string) => {
    try {
      return readFileSync(join(packDir, file));
    } catch {
      return undefined;
    }
  };
  const manifestBytes = read(PACK_FILES.manifest);
  if (!manifestBytes) throw new VerifyError([`${PACK_FILES.manifest} is missing`]);
  // Format, sizes, hashes and every entry's bytes, as at install.
  validatePack(manifestBytes, read, sha256);
  const manifest = parseManifest(JSON.parse(manifestBytes.toString('utf8')));
  const table = mapTable(read(manifest.table.file) as Uint8Array);
  const rows = parseProvenance((read(manifest.provenance.file) as Uint8Array).toString());
  if (rows.length !== manifest.provenance.rows)
    fail(`provenance has ${rows.length} rows, manifest says ${manifest.provenance.rows}`);

  const inputs = loadInputs(inputsDir);
  const lexicon = buildLexicon(inputs);
  const vetoes = new Set(Object.keys(inputs.baseVetoes));
  const casePolicy = JSON.parse((read(manifest.casePolicy.file) as Uint8Array).toString()) as {
    lowercaseOnly: string[];
  };
  const lowercaseOnly = new Set(casePolicy.lowercaseOnly);

  const byKey = new Map<string, ProvenanceRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.key);
    if (list) list.push(row);
    else byKey.set(row.key, [row]);
  }

  let entryAssertions = 0;
  for (let i = 0; i < table.entries; i++) {
    const key = keyAt(table, i);
    const value = valueAt(table, i);
    const sources = byKey.get(key);
    if (!sources || sources.some((r) => r.value !== value))
      fail(`entry "${key}"→"${value}" does not match its provenance`);
    else entryAssertions++;
    if (lookup(table, key) !== value) fail(`lookup("${key}") does not return its value`);
    else entryAssertions++;
    byKey.delete(key);
  }
  for (const key of byKey.keys()) fail(`provenance row for "${key}", which the table lacks`);
  if (table.entries === manifest.table.entries) entryAssertions++;
  else fail(`table has ${table.entries} entries, manifest says ${manifest.table.entries}`);
  const present = MUST_BE_ABSENT.filter((k) => lookup(table, k) !== undefined);
  if (present.length === 0) entryAssertions++;
  else fail(`keys that must stay uncorrected are in the table: ${present.join(', ')}`);

  const scowlPrefix = `${inputs.scowlRoot}/final/`;
  let generatedRows = 0;
  let authoredRows = 0;
  let overrideRows = 0;
  let reverseChecks = 0;
  for (const row of rows) {
    const { key, value } = row;
    if (row.origin === 'scowl-generated') {
      generatedRows++;
      const list = row.file.startsWith(scowlPrefix)
        ? inputs.scowlLists.get(row.file.slice(scowlPrefix.length))
        : undefined;
      if (!list || list[row.line - 1] !== value) fail(`"${key}": ${row.file} line ${row.line} is not "${value}"`);
      const fileLevel = Number(/\.(\d+)$/.exec(row.file)?.[1]);
      if (row.level !== fileLevel || fileLevel > TARGET_MAX_LEVEL) fail(`"${key}": level ${row.level} for ${row.file}`);
      if (!isOneEdit(key, value)) fail(`"${key}" is not one slip from "${value}"`);
      if (key.length < STRICT.minKeyLength) fail(`"${key}" is shorter than ${STRICT.minKeyLength}`);
      if (lexicon.realWords.has(key)) fail(`"${key}" is a real word`);
      if (lexicon.protectedTerms.has(key)) fail(`"${key}" is a protected term`);
      if (vetoes.has(key)) fail(`"${key}" was vetoed in review`);
      reverseChecks++;
      const other = findOneEdit(key, (s) => s !== value && (lexicon.guard.get(s) ?? 100) <= STRICT.maxCompetitorLevel);
      if (other !== undefined)
        fail(`"${key}"→"${value}" is one edit from "${other}" (level ${lexicon.guard.get(other)}) too`);
    } else if (row.origin === 'authored') {
      authoredRows++;
      const parts = (inputs.authored[row.line - 1] ?? '').trim().split(/\s+/);
      if (
        row.file !== 'authored.txt' ||
        parts[0] !== key ||
        parts.slice(1, -1).join(' ') !== value ||
        parts.at(-1) !== row.category
      ) {
        fail(`"${key}": authored.txt line ${row.line} does not say "${key} ${value} ${row.category}"`);
      }
      if (inputs.authoredReview.rejected[key] !== undefined) fail(`"${key}" was rejected in review`);
      if (!lowercaseOnly.has(key) && (lexicon.realWords.has(key) || lexicon.protectedTerms.has(key))) {
        fail(`"${key}" is a real word or protected term and not a reviewed exception`);
      }
    } else {
      overrideRows++;
      const parts = (inputs.inlineOverrides[row.line - 1] ?? '').trim().split(/\s+/);
      if (row.file !== 'inline-overrides.txt' || parts[0] !== key || parts[1] !== value) {
        fail(`"${key}": inline-overrides.txt line ${row.line} does not map it to "${value}"`);
      }
    }
  }
  for (const key of lowercaseOnly) {
    if (!rows.some((r) => r.key === key && r.origin === 'authored'))
      fail(`case policy key "${key}" is not an authored entry`);
  }
  if (failures.length) throw new VerifyError(failures);
  return { entries: table.entries, entryAssertions, generatedRows, authoredRows, overrideRows, reverseChecks };
}

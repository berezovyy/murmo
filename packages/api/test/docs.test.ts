// Docs match code: round 14 authors were confused by an api.md that still named
// an old draft (lesson 72, E22), and limits written by hand drift from code (E5,
// E6). The author and adapter docs name constants as `LIMITS.x` / `DEADLINES.x`
// followed by a value, in parentheses or in the next table cell; each value must
// equal limits.ts, and the only draft label allowed is API_DRAFT.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { API_DRAFT, DEADLINES, KEY_CONDITIONS, LIMITS, PERMISSIONS } from '../src/index.ts';

const DOCS = ['api.md', 'AUTHORING.md', 'MANIFEST.md', 'PORTING.md'] as const;
const read = (name: string) => readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8');

const UNITS: Readonly<Record<string, number>> = { KiB: 1024, MiB: 1024 * 1024 };

/** The value a doc states, in the constant's own unit (bytes, MiB, ms or a count). */
function stated(name: string, text: string): number | null {
  const m = /^\s*([\d][\d,_]*)\s*(KiB|MiB|ms|bytes)?\b/.exec(text);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/[,_]/g, ''));
  const unit = m[2];
  if (name.endsWith('Bytes') && unit && unit in UNITS) return n * (UNITS[unit] ?? 1);
  return n;
}

/** Every mismatch between `doc` and the code; empty when they agree. */
export function docProblems(doc: string): string[] {
  const problems: string[] = [];
  const tables: Record<string, Readonly<Record<string, number>>> = { LIMITS, DEADLINES };
  for (const m of doc.matchAll(/`(LIMITS|DEADLINES)\.(\w+)`(?:\s*\(([^)]*)\)|\s*\|([^|\n]*)\|)?/g)) {
    const [, table = '', name = '', inParens, inCell] = m;
    const actual = tables[table]?.[name];
    if (actual === undefined) {
      problems.push(`${table}.${name} does not exist`);
      continue;
    }
    const text = inParens ?? inCell;
    if (text === undefined) continue;
    const value = stated(name, text);
    if (value !== null && value !== actual) problems.push(`${table}.${name} is ${actual}, the doc says ${text.trim()}`);
  }
  for (const m of doc.matchAll(/(?<![\d.])\d+\.\d+-pre(?:\.\d+)?(?![\d.])/g)) {
    if (m[0] !== API_DRAFT) problems.push(`draft label ${m[0]} is not the current ${API_DRAFT}`);
  }
  for (const m of doc.matchAll(/\bdraft\s+(\d[\w.-]*)/gi)) {
    if (m[1] !== API_DRAFT) problems.push(`"${m[0]}" names a draft other than ${API_DRAFT}`);
  }
  return problems;
}

for (const name of DOCS) {
  test(`${name} states every constant as limits.ts has it and names only draft ${API_DRAFT}`, () => {
    assert.deepEqual(docProblems(read(name)), []);
  });

  test(`${name} carries the preview banner, so nobody reads the preview as a stable contract`, () => {
    assert.match(
      read(name),
      new RegExp(`^> \\*\\*Preview, draft \`${API_DRAFT.replace(/\./g, '\\.')}\`\\.\\*\\*`, 'm'),
    );
  });
}

test('planted mismatches fail the doc check', () => {
  assert.deepEqual(docProblems('`LIMITS.editsPerSecond` (20) and `DEADLINES.changeMs` (100 ms)'), []);
  assert.equal(docProblems('`LIMITS.editsPerSecond` (25)').length, 1);
  assert.equal(docProblems('| `LIMITS.sourceBytes` | 2 MiB |').length, 1);
  assert.equal(docProblems('`DEADLINES.changeMs` (50 ms)').length, 1);
  assert.equal(docProblems('`LIMITS.noSuchLimit`').length, 1);
  assert.equal(docProblems('Draft 1.3 is additive').length, 1, 'the stale header that confused r14 authors');
  assert.equal(docProblems('the 2.0-pre migration').length, 1);
  assert.deepEqual(docProblems('package 2.0.0-pre.0'), [], 'a package version is not a draft label');
});

test('every limit and deadline appears in the api.md table', () => {
  const doc = read('api.md');
  for (const name of Object.keys(LIMITS)) assert.match(doc, new RegExp(`\\| \`LIMITS\\.${name}\` \\|`), name);
  for (const name of Object.keys(DEADLINES)) assert.match(doc, new RegExp(`\\| \`DEADLINES\\.${name}\` \\|`), name);
});

test('api.md names every permission and key condition', () => {
  const doc = read('api.md');
  for (const name of [...PERMISSIONS, ...KEY_CONDITIONS]) assert.ok(doc.includes(`\`${name}\``), name);
});

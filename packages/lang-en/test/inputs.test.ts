import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { AuthoredEntry } from '../src/authored.ts';
import { addOverrides, BuildError, mergeAuthored } from '../src/build.ts';
import { defaultInputsDir, InputError, lines, loadInputs, readSources } from '../src/inputs.ts';
import type { ProvenanceRow } from '../src/provenance.ts';
import { csvLine, PROVENANCE_COLUMNS, parseProvenance } from '../src/provenance.ts';

const root = mkdtempSync(join(tmpdir(), 'murmo-lang-en-inputs-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('every input is pinned, and a changed input stops the build', () => {
  // Round 7 read /usr/share/dict/words and live vocab caches (E3): a different machine built different data.
  const sources = readSources();
  for (const pin of sources.inputs) {
    assert.match(pin.sha256, /^[0-9a-f]{64}$/, pin.name);
    assert.ok(pin.bytes > 0, pin.name);
    assert.ok(pin.license.length > 0, `${pin.name} records its license`);
  }
  const dir = join(root, 'inputs');
  cpSync(defaultInputsDir, dir, { recursive: true });
  const authored = join(dir, 'authored.txt');
  writeFileSync(authored, `${readFileSync(authored, 'utf8')}teh tea transpose\n`);
  assert.throws(() => loadInputs(dir), InputError);
});

test('the system dictionary and project terms come from the frozen copies, not the machine', () => {
  // The frozen copies' content hashes are round 7's (source-manifest.json) and the TS freeze's.
  const inputs = loadInputs();
  const pin = (name: string) => inputs.pins.find((p) => p.name === name);
  assert.equal(pin('web2')?.contentSha256, 'be41ad97963bf8dabedd5871d5d691596175269d540956b0f9965a885c2bbab9');
  assert.equal(pin('project-terms')?.contentSha256, 'b7c4b953d3c0707e52f1259fd020ceca416a7fa97206746ad7eb5f26e30ca200');
  assert.equal(inputs.web2.length, 235976);
  assert.equal(inputs.projectTerms.length, 72462);
});

test('line splitting matches Python’s splitlines or refuses the input', () => {
  // The provenance line numbers are round 7's Python line numbers; a CR or U+2028 would shift them.
  assert.deepEqual(lines('a\nb\n', 'x'), ['a', 'b']);
  assert.deepEqual(lines('a\n\nb', 'x'), ['a', '', 'b']);
  assert.throws(() => lines('a\r\nb', 'x'), InputError);
  assert.throws(() => lines('a b', 'x'), InputError);
});

const entry = (key: string, value: string, line: number): AuthoredEntry => ({
  key,
  value,
  category: 'misspelling',
  line,
  review: 'reviewed',
});

test('an authored line never silently replaces a generated mapping', () => {
  // Plan 12, Build step 4: base mappings are never replaced silently.
  const merged = new Map([['recieve', 'receive']]);
  const rows: ProvenanceRow[] = [];
  assert.equal(mergeAuthored(merged, rows, [entry('recieve', 'receive', 3), entry('teh', 'the', 4)]), 1);
  assert.equal(rows.length, 2, 'a key both sources map to the same word keeps both provenance rows');
  assert.throws(() => mergeAuthored(merged, [], [entry('recieve', 'relieve', 9)]), BuildError);
});

test('an inline override may only add a key', () => {
  const merged = new Map([['teh', 'the']]);
  assert.equal(addOverrides(merged, [], ['wich which misspelling']), 1);
  assert.throws(() => addOverrides(merged, [], ['teh ten misspelling']), BuildError);
  assert.throws(() => addOverrides(merged, [], ['bad line']), BuildError);
});

test('provenance CSV round-trips quoting', () => {
  // Authored categories and file names are ours, but a comma or quote must not shift columns.
  const row: ProvenanceRow = {
    key: 'teh',
    value: 'the',
    origin: 'authored',
    category: 'a,"b"',
    file: 'authored.txt',
    line: 4,
    level: '',
    review: 'reviewed',
  };
  const text = `${PROVENANCE_COLUMNS.join(',')}\n${csvLine(row)}\n`;
  assert.deepEqual(parseProvenance(text), [row]);
});

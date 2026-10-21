// 29 splitter cases from experiments/names/match/splitter-fixture.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { splitWords } from '../src/split.ts';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/names/splitter-fixture.json');

test('names.splitWords matches the 29 NFC splitter cases', () => {
  const data = JSON.parse(readFileSync(fixture, 'utf8')) as { cases: { input: string; words: string[] }[] };
  assert.equal(data.cases.length, 29);
  for (const row of data.cases) {
    assert.deepEqual(splitWords(row.input), row.words, row.input);
  }
});

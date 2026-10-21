import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  encodeTable,
  findEntry,
  keyAt,
  lookup,
  mapTable,
  TABLE_MAGIC,
  type TableErrorCode,
  validateTable,
} from '../src/index.ts';

const sample = encodeTable([
  ['teh', 'the'],
  ['adn', 'and'],
  ['recieve', 'receive'],
  ['i', 'I'],
]);

const throwsCode = (fn: () => unknown, code: TableErrorCode) =>
  assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code, `expected ${code}`);

function patched(bytes: Uint8Array, word: number, value: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  new DataView(copy.buffer).setUint32(word * 4, value, true);
  return copy;
}

test('mapTable wraps the caller’s buffer without copying it', () => {
  // Round 13's registration copied the table, so the native heap held two (4.28 MiB, r13 E6).
  const table = mapTable(sample);
  assert.equal(table.data.buffer, sample.buffer);
  assert.equal(table.keyOffsets.buffer, sample.buffer);
  sample[sample.length - 1] = 'E'.charCodeAt(0);
  assert.equal(lookup(table, 'teh'), 'thE', 'a view sees writes to the shared bytes');
  sample[sample.length - 1] = 'e'.charCodeAt(0);
});

test('lookup finds every key and nothing else, with sorted keys and the r13 header layout', () => {
  const table = mapTable(sample);
  assert.equal(table.entries, 4);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => keyAt(table, i)),
    ['adn', 'i', 'recieve', 'teh'],
  );
  for (const [k, v] of [
    ['teh', 'the'],
    ['adn', 'and'],
    ['recieve', 'receive'],
    ['i', 'I'],
  ]) {
    assert.equal(lookup(table, k as string), v);
  }
  // Prefixes, extensions, case variants and non-ASCII must miss, not match a neighbor.
  for (const miss of ['', 'te', 'tehh', 'Teh', 'té', 'adn ', 'zzz', 'a'])
    assert.equal(findEntry(table, miss), -1, miss);
  const header = new Uint32Array(sample.buffer, 0, 8);
  assert.deepEqual([...header], [TABLE_MAGIC, 4, 32 + 8 * 5, 'adnirecievetehandIreceivethe'.length, 0, 0, 0, 0]);
  assert.deepEqual(validateTable(table), { entries: 4, keyBytes: 14, valueBytes: 14 });
});

test('mapTable refuses headers it cannot trust, with a code', () => {
  // Each of these would make binary search read outside the table or misread another index.
  throwsCode(() => mapTable(patched(sample, 0, 1234)), 'unknown-format');
  throwsCode(() => mapTable(patched(sample, 5, 7)), 'unknown-format'); // packed.mjs stores trie nodes here
  throwsCode(() => mapTable(patched(sample, 1, 5)), 'bad-header');
  throwsCode(() => mapTable(patched(sample, 2, 80)), 'bad-header');
  throwsCode(() => mapTable(patched(sample, 3, 999)), 'bad-header');
  throwsCode(() => mapTable(sample.subarray(0, sample.length - 1)), 'bad-header');
  throwsCode(() => mapTable(sample.subarray(0, 16)), 'truncated');
  const shifted = new Uint8Array(sample.length + 2);
  shifted.set(sample, 2);
  throwsCode(() => mapTable(shifted.subarray(2)), 'misaligned');
  // The last value offset must end the data.
  throwsCode(() => mapTable(patched(sample, 8 + 5 + 4, 3)), 'bad-offsets');
});

test('validateTable catches what mapTable leaves to install: per-entry offsets, bytes and order', () => {
  // keyOffsets[1] past keyOffsets[2]: an out-of-range entry.
  throwsCode(() => validateTable(mapTable(patched(sample, 8 + 1, 40))), 'bad-offsets');
  const dataStart = 32 + 8 * 5;
  const unsorted = new Uint8Array(sample);
  unsorted[dataStart] = 'z'.charCodeAt(0); // "adn" → "zdn", before "i"
  throwsCode(() => validateTable(mapTable(unsorted)), 'unsorted');
  const control = new Uint8Array(sample);
  control[dataStart + 1] = 0x0a;
  throwsCode(() => validateTable(mapTable(control)), 'bad-entry');
});

test('encodeTable refuses entries the reader could not find or the inline path could not insert', () => {
  throwsCode(
    () =>
      encodeTable([
        ['teh', 'the'],
        ['teh', 'ten'],
      ]),
    'bad-input',
  );
  throwsCode(() => encodeTable([['té', 'the']]), 'bad-input');
  throwsCode(() => encodeTable([['a b', 'the']]), 'bad-input');
  throwsCode(() => encodeTable([['', 'x']]), 'bad-input');
  throwsCode(() => encodeTable([['x', '']]), 'bad-input');
  throwsCode(() => encodeTable([['x'.repeat(65), 'y']]), 'bad-input');
  // An empty table is valid and maps.
  assert.equal(mapTable(encodeTable([])).entries, 0);
});

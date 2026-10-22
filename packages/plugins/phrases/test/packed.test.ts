// Packed layout: prefix top-5, atomic rebuild round-trip. Catches a broken
// offset table or a mixed generation (E1, E2).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockPrefix, buildPacked, Completion, keyAt, mapPacked, valueAt } from '../src/packed.ts';

test('build/map round-trip keeps keys, values and prefix top-5', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    key: `update the cache module ${String(i).padStart(3, '0')}`,
    value: JSON.stringify({ count: 40 - i }),
    score: 40 - i,
  }));
  const bytes = buildPacked(rows);
  const index = mapPacked(bytes);
  assert.ok(index);
  assert.equal(index.n, 40);
  const ids = blockPrefix(index, 'update the cache');
  assert.ok(ids.length <= 5);
  assert.equal(keyAt(index, ids[0] as number), rows[0]?.key);
  assert.equal(JSON.parse(valueAt(index, ids[0] as number)).count, 40);
});

test('Completion.fresh is a new block query, not a queued continuation (E2)', () => {
  const rows = ['alpha', 'alpine', 'beta', 'alphabet'].map((key, i) => ({ key, value: '1', score: i + 1 }));
  const index = mapPacked(buildPacked(rows));
  assert.ok(index);
  const c = new Completion(index);
  const first = c.search('al');
  const fresh = c.fresh('b');
  assert.ok(first.length > 0);
  assert.equal(keyAt(index, fresh[0] as number).startsWith('b'), true);
});

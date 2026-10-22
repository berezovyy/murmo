// Round 13 shipped magic 0 and patched it in memory (E16). The pack must refuse.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeTable, TABLE_MAGIC } from '@murmo/lang';
import { checkTableBytes, DataError } from '../src/data.ts';

test('a table with magic 0 or a wrong entry count fails the pack, and is not repaired', () => {
  const good = encodeTable([
    ['adn', 'and'],
    ['teh', 'the'],
  ]);
  const { magic, entries } = checkTableBytes(good, 2);
  assert.equal(magic, TABLE_MAGIC);
  assert.equal(entries, 2);

  const zero = new Uint8Array(good);
  new DataView(zero.buffer).setUint32(0, 0, true);
  assert.throws(
    () => checkTableBytes(zero),
    (err: unknown) => {
      assert.ok(err instanceof DataError);
      assert.match(err.message, /magic is 0; refusing to repair/);
      return true;
    },
  );
  assert.equal(new DataView(zero.buffer).getUint32(0, true), 0);

  assert.throws(() => checkTableBytes(good, 99), /expected 99/);
});

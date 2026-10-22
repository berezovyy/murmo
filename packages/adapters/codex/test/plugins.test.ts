// Table views with a byteOffset must not be hashed as the whole buffer (r10 packed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeTable } from '@murmo/lang';
import { englishPackAsset, installTestPolicy } from '@murmo/plugin-autocorrect';
import { installTable, tableBytes } from '../src/js/plugins.ts';

test('tableBytes copies an offset view, not the whole ArrayBuffer', () => {
  const prefix = new Uint8Array([1, 2, 3, 4]);
  const table = encodeTable([['teh', 'the']]);
  const combined = new Uint8Array(prefix.length + table.length);
  combined.set(prefix);
  combined.set(table, prefix.length);
  const view = new Uint8Array(combined.buffer, prefix.length, table.length);
  const copied = tableBytes(view);
  assert.ok(copied);
  assert.equal(copied.byteLength, table.length);
  assert.deepEqual([...copied], [...table]);
});

test('installTable still provides the pack when JS sha256 would disagree', () => {
  const bytes = encodeTable([['teh', 'the']]);
  installTable(bytes, { sha256: 'not-the-real-hash', entries: 1, lowercaseOnly: [] });
  const pack = englishPackAsset();
  assert.ok(pack);
  assert.equal(pack.entries, 1);
  assert.equal(pack.bytes.byteLength, bytes.byteLength);
  installTestPolicy();
});

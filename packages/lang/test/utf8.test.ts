import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeUtf8 } from '../src/index.ts';

test('decodeUtf8 matches TextDecoder on valid text, across its chunk size', () => {
  // QuickJS has no TextDecoder, so manifests and records go through this decoder everywhere.
  const text = `${'a'.repeat(4095)}é😀 ${'ж'.repeat(5000)}🇺🇦`;
  const bytes = new TextEncoder().encode(text);
  assert.equal(decodeUtf8(bytes), new TextDecoder().decode(bytes));
});

test('decodeUtf8 refuses invalid UTF-8 instead of repairing it', () => {
  // A manifest with replaced bytes could name different files than the one that was hashed.
  for (const bad of [
    [0xff],
    [0xc0, 0xaf],
    [0xe0, 0x80, 0xaf],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xe2, 0x82],
  ]) {
    assert.throws(() => decodeUtf8(new Uint8Array(bad)), /invalid UTF-8/, bad.join(','));
  }
});

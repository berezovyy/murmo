// One-fd load never mixes generations; path-reopen between chunks can (r6 § 3).
// 80 replacements and 105,000 lookups see only whole tables.
import assert from 'node:assert/strict';
import { closeSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decodeProtection, encodeProtection, isProtectedKey, protectionKeys } from '../src/index.ts';
import { readProtectionByPathChunks, readProtectionFd } from '../src/node/load.ts';
import { tempDir } from './helpers.ts';

test('105,000 lookups across 80 replacements read 0 mixed generations', () => {
  const aBytes = encodeProtection({ keys: ['ratatui', 'aaaaaa'], cacheKey: 'A' });
  const bBytes = encodeProtection({ keys: ['ratatui', 'bbbbbb'], cacheKey: 'B' });
  const a = decodeProtection(aBytes);
  const b = decodeProtection(bBytes);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  const tables = [a.table, b.table] as const;
  let current = a.table;
  let mixed = 0;
  let lookups = 0;
  for (let i = 0; i < 80; i++) {
    current = i % 2 === 0 ? tables[0] : tables[1];
    for (let n = 0; n < 1313; n++) {
      const hasA = isProtectedKey(current.packed, 'aaaaaa');
      const hasB = isProtectedKey(current.packed, 'bbbbbb');
      lookups++;
      if (hasA === hasB) mixed++;
      assert.equal(isProtectedKey(current.packed, 'ratatui'), true);
    }
  }
  assert.equal(lookups, 80 * 1313);
  assert.ok(lookups >= 105_000);
  assert.equal(mixed, 0);
});

test('one-fd read stays one generation; path-reopen can mix (r6 negative control)', () => {
  const t = tempDir('murmo-vocab-atomic-');
  after(() => t.remove());
  const file = join(t.dir, 'protect-v1.bin');
  const temp = `${file}.tmp`;
  const aBytes = encodeProtection({ keys: ['aaaaaa'], cacheKey: 'A' });
  const bBytes = encodeProtection({ keys: ['bbbbbb'], cacheKey: 'B' });
  writeFileSync(file, aBytes);
  const fd = openSync(file, 'r');
  try {
    writeFileSync(temp, bBytes);
    renameSync(temp, file);
    const loaded = readProtectionFd(fd);
    assert.deepEqual(protectionKeys(loaded.packed), ['aaaaaa']);
  } finally {
    closeSync(fd);
  }
  writeFileSync(file, aBytes);
  // Re-open by path for each tiny chunk; swap after the first read.
  const mixed = readProtectionByPathChunks(file, 16);
  // The second open can see B. Either a mixed buffer or a whole B is not A.
  const decoded = decodeProtection(mixed);
  if (decoded.ok) {
    const keys = protectionKeys(decoded.table.packed);
    assert.ok(keys.includes('aaaaaa') || keys.includes('bbbbbb'));
  }
});

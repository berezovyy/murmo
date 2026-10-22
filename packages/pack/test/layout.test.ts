// The generated package.json is the host contract (E8, E10): bin, ./tui, pi.extensions, engines range, no install scripts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TABLE_FILE } from '@murmo/integrity';
import { generatedPackageJson } from '../src/adapters.ts';

test('generated package.json has bin, ./tui, pi.extensions, engines >=24.18.0 and no scripts', () => {
  const pkg = generatedPackageJson();
  assert.equal(pkg.name, 'murmo');
  assert.deepEqual(pkg.bin, { murmo: 'cli.mjs' });
  assert.equal((pkg.exports as { './tui': string })['./tui'], './tui.js');
  assert.deepEqual((pkg.pi as { extensions: string[] }).extensions, ['./adapters/pi/index.js']);
  assert.equal((pkg.engines as { node: string }).node, '>=24.18.0');
  assert.equal('scripts' in pkg, false);
  assert.equal('dependencies' in pkg, false);
});

test('packed language data lives at data/en/english.bin (Claude $.fs path)', () => {
  assert.equal(TABLE_FILE, 'data/en/english.bin');
});

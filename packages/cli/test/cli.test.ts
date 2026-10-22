// Packed CLI must not embed a public key (E4).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';
import { capture } from './helpers.ts';

test('the CLI source does not contain a baked-in PEM public key', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf8');
  assert.equal(/BEGIN PUBLIC KEY/.test(src), false);
  assert.equal(/PUBLIC_KEY\s*=/.test(src), false);
});

test('unknown commands and missing argv are usage (exit 2)', async () => {
  const io = capture();
  assert.equal(await main([], { out: io.writeOut, err: io.writeErr }), 2);
  assert.equal(await main(['nope'], { out: io.writeOut, err: io.writeErr }), 2);
});

test('plugin enable/disable stay phase 28', async () => {
  const io = capture();
  assert.equal(await main(['plugin', 'enable', 'x'], { out: io.writeOut, err: io.writeErr }), 2);
  assert.match(io.err.join(''), /phase 28/);
});

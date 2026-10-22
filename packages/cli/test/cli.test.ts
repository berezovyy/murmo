// The packed CLI must not claim setup works, and must not embed a public key (E4).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';

test('setup, uninstall and doctor are phase 27, not implemented here', () => {
  assert.equal(main(['setup']), 2);
  assert.equal(main(['uninstall']), 2);
  assert.equal(main(['doctor']), 2);
});

test('the CLI source does not contain a baked-in PEM public key', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf8');
  assert.equal(/BEGIN PUBLIC KEY/.test(src), false);
  assert.equal(/PUBLIC_KEY\s*=/.test(src), false);
});

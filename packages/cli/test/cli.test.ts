// Packed CLI must not embed a public key (E4).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, shortcutsEnvJson } from '../src/cli.ts';
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

test('Codex wrapper env JSON includes trusted shortcut names (menu overlay is off on Codex)', () => {
  const json = shortcutsEnvJson([
    { shortcut: ';rvw', text: 'Review this change.' },
    { shortcut: ';tst', text: 'Run the tests.' },
  ]);
  assert.ok(json);
  const map = JSON.parse(json) as Record<string, string>;
  assert.equal(map[';rvw'], 'Review this change.');
  assert.equal(map[';tst'], 'Run the tests.');
  assert.equal(shortcutsEnvJson([]), undefined);
});

test('plugin help is mounted (phase 28)', async () => {
  const io = capture();
  assert.equal(await main(['plugin', 'help'], { out: io.writeOut, err: io.writeErr }), 0);
});

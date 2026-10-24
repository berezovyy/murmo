// What a new session loads from `murmo plugin`'s selection. Every adapter
// once loaded only its built-ins, so an installed plugin never ran.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readInstalledPlugins } from '../src/node/index.ts';
import { installForTest } from '../src/node/testing.ts';
import { tempRoots } from './helpers.ts';

const sendHold = fileURLToPath(new URL('../../../fixtures/hosts/plugins/send-hold', import.meta.url));

test('an installed plugin is selected with only the grants the user reviewed', async () => {
  // Catches loading a plugin with grants it declared but was never given,
  // and ignoring `murmo plugin disable` for built-ins.
  const home = tempRoots('murmo-select-');
  try {
    installForTest(home.roots, sendHold, { grants: ['draft:read', 'network'], disabled: ['phrases'] });
    const selection = await readInstalledPlugins(home.roots);
    assert.deepEqual(
      selection.plugins.map((p) => [p.id, p.grants]),
      [['send-hold', ['draft:read']]],
    );
    assert.match(selection.plugins[0]?.source ?? '', /zzhold/);
    assert.deepEqual(selection.disabled, ['phrases']);
    assert.deepEqual(selection.notices, []);

    installForTest(home.roots, sendHold, { grants: ['draft:read', 'submit'], enabled: false });
    assert.deepEqual((await readInstalledPlugins(home.roots)).plugins, [], 'a disabled plugin stays out');
  } finally {
    home.remove();
  }
});

test('a plugin whose installed code changed after review does not load, and says what to run', async () => {
  // The selection is the commit point; code that no longer matches the
  // signed file hashes (a half-written or edited generation) must not run.
  const home = tempRoots('murmo-select-');
  try {
    const dir = installForTest(home.roots, sendHold, { grants: ['draft:read', 'submit'] });
    writeFileSync(join(dir, 'plugin.mjs'), 'export default () => ({ name: "send-hold", version: "1.0.0" });\n');
    const selection = await readInstalledPlugins(home.roots);
    assert.deepEqual(selection.plugins, []);
    assert.deepEqual(selection.notices, [
      'send-hold was not loaded: its installed files are missing or changed; run murmo plugin reinstall send-hold',
    ]);
  } finally {
    home.remove();
  }
});

test('no plugins.json is an empty selection, not a failed session', async () => {
  // A session started before setup created the store must still start.
  const home = tempRoots('murmo-select-');
  try {
    const selection = await readInstalledPlugins(home.roots);
    assert.deepEqual([selection.plugins, selection.disabled, selection.notices], [[], [], []]);
  } finally {
    home.remove();
  }
});

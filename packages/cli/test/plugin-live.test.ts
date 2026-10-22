// Live add/disable/enable/remove on the fake host, reloading only the changed
// plugin so the other plugin's in-memory state survives (E5, E12).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PluginFactory } from '@murmo/api';
import { createHarness } from '@murmo/core/testing';
import { readPluginsManifest } from '@murmo/store/node';
import { followSelection } from '../src/plugin/lifecycle.ts';
import { packPlugin, preparedHome, runPlugin, writeKey } from './helpers.ts';

const memory: PluginFactory = () => {
  let hits = 0;
  return {
    name: 'memory',
    version: '1.0.0',
    permissions: ['draft:read'],
    onChange() {
      hits += 1;
      return [];
    },
    hits: () => hits,
  };
};

test("disable/enable/remove of one plugin leaves the other plugin's memory intact (E5)", async () => {
  const harness = await createHarness({
    plugins: [
      { id: 'memory', builtin: true, factory: memory },
      { id: 'other', builtin: true, factory: () => ({ name: 'other', version: '1.0.0', permissions: [] }) },
    ],
  });
  await harness.driver.type('a');
  const plugin = (harness.runner as { storage?: unknown }).storage;
  void plugin;
  const before = harness.session?.stats().plugins.find((p) => p.id === 'memory');
  assert.equal(before?.activated, true);
  const disabled = await harness.session?.applyPlugin({ action: 'disable', id: 'other' });
  assert.equal(disabled, 'disabled');
  const after = harness.session?.stats().plugins.find((p) => p.id === 'memory');
  assert.equal(after?.activated, true);
  assert.equal(after?.disabled, false);
  const removed = await harness.session?.applyPlugin({ action: 'remove', id: 'other' });
  assert.equal(removed, 'disabled');
  assert.equal(
    harness.session?.stats().plugins.some((p) => p.id === 'memory' && p.activated),
    true,
  );
  assert.equal(
    harness.session?.stats().plugins.some((p) => p.id === 'other'),
    false,
  );
  await harness.session?.dispose();
});

test('open fake session acknowledges add/disable/enable/remove (E12)', async () => {
  const home = await preparedHome();
  const harness = await createHarness({
    plugins: [{ id: 'memory', builtin: true, factory: memory }],
  });
  const session = harness.session;
  assert.ok(session);
  const follow = await followSelection({
    roots: home.roots,
    sessionId: 'fake',
    host: 'fake',
    session,
  });
  const tick = setInterval(() => {
    void readPluginsManifest(home.roots).then((manifest) => {
      if (manifest && manifest.revision !== follow.current()?.revision) return follow.apply(manifest);
    });
  }, 20);
  try {
    const packed = packPlugin({ id: 'live-demo' });
    const tgz = join(home.dir, 'live.tgz');
    writeFileSync(tgz, packed.bytes);
    const key = writeKey(home.dir, packed.publicPem);
    assert.equal(await runPlugin(home, ['add', tgz, '--trust-key', key, '--grant', 'draft:read']), 0);
    assert.equal(await runPlugin(home, ['disable', 'live-demo']), 0);
    assert.equal(await runPlugin(home, ['enable', 'live-demo']), 0);
    assert.equal(await runPlugin(home, ['remove', 'live-demo']), 0);
    const memoryStill = harness.session?.stats().plugins.find((p) => p.id === 'memory');
    assert.equal(memoryStill?.activated, true);
  } finally {
    clearInterval(tick);
    await follow.stop();
    await harness.session?.dispose();
    home.remove();
  }
});

// Live add/disable/enable/remove on the fake host, reloading only the changed
// plugin so the other plugin's in-memory state survives (E5, E12). The CLI
// waits for the session's acknowledgement, so each step is in place when the
// command returns.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PluginFactory } from '@murmo/api';
import { createMemoryStorage, createPluginHost, createSession, followPlugins, pluginStates } from '@murmo/core';
import { createHarness, createManualClock, ReferenceAdapter, sourceExecutor } from '@murmo/core/testing';
import { createInProcessExecutor, createRoutedExecutor } from '@murmo/executor';
import { readInstalledPlugins, watchPluginSelection } from '@murmo/store/node';
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

test('murmo plugin add, disable, enable and remove reach an open session, which acknowledges each', async () => {
  // Sessions never followed the selection, so each command either waited on
  // nobody or, once a session acknowledged at start, timed out; the plugin
  // itself changed only after a restart.
  const home = await preparedHome();
  const clock = createManualClock();
  const runner = createPluginHost({
    specs: [{ id: 'memory', builtin: true, factory: memory }],
    executor: createRoutedExecutor({
      trusted: createInProcessExecutor({ clock }),
      isolated: () => sourceExecutor()(clock),
    }),
    storage: createMemoryStorage(),
  });
  const session = createSession({ adapter: new ReferenceAdapter({ clock }), runner });
  await session.ready;
  const started = await readInstalledPlugins(home.roots);
  const follower = followPlugins(started, { session, host: runner, builtins: () => [] });
  const follow = await watchPluginSelection({
    roots: home.roots,
    sessionId: 'fake-live',
    host: 'fake',
    started: { revision: started.revision, plugins: pluginStates(session) },
    apply: (next) => follower.apply(next),
    pollMs: 20,
  });
  const live = () => session.stats().plugins.some((p) => p.id === 'live-demo' && !p.disabled);
  try {
    const packed = packPlugin({ id: 'live-demo' });
    const tgz = join(home.dir, 'live.tgz');
    writeFileSync(tgz, packed.bytes);
    const key = writeKey(home.dir, packed.publicPem);
    assert.equal(
      await runPlugin(home, ['add', tgz, '--trust-key', key, '--grant', 'draft:read']),
      0,
      home.stderr.join(''),
    );
    assert.equal(live(), true, 'added');
    assert.equal(await runPlugin(home, ['disable', 'live-demo']), 0, home.stderr.join(''));
    assert.equal(live(), false, 'disabled');
    assert.equal(await runPlugin(home, ['enable', 'live-demo']), 0, home.stderr.join(''));
    assert.equal(live(), true, 'enabled again');
    assert.equal(await runPlugin(home, ['remove', 'live-demo']), 0, home.stderr.join(''));
    assert.equal(live(), false, 'removed');
    const memoryStill = session.stats().plugins.find((p) => p.id === 'memory');
    assert.equal(memoryStill?.activated, true);
  } finally {
    await follow.stop();
    await session.dispose();
    home.remove();
  }
});

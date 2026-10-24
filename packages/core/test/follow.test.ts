// What a running session does when `murmo plugin` changes the selection.
// The Pi, OpenCode and Claude tests prove add and disable end to end; this
// covers the rest: built-ins turned off and on (one that began the session
// off has to load), and a grant change, which must reach the running copy.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Permission, PluginFactory, PluginManifest } from '@murmo/api';
import { createInProcessExecutor, createRoutedExecutor } from '@murmo/executor';
import {
  createMemoryStorage,
  createPluginHost,
  createSession,
  followPlugins,
  type HostPluginSpec,
  type InstalledSelection,
} from '../src/index.ts';
import { createManualClock, ReferenceAdapter } from '../src/testing/index.ts';
import { sourceExecutor } from '../src/testing/source-executor.ts';

const builtin = (name: string): HostPluginSpec => ({
  id: name,
  builtin: true,
  factory: (() => ({ name, version: '1.0.0', permissions: [] })) satisfies PluginFactory,
});

const manifest: PluginManifest = {
  name: 'guest',
  version: '1.0.0',
  api: '^2.0.0',
  entry: 'plugin.mjs',
  permissions: [
    { name: 'draft:read', reason: 'r' },
    { name: 'project:list', reason: 's' },
  ],
  capabilities: { required: {}, optional: {} },
  settingsSchema: { type: 'object', properties: {}, additionalProperties: false },
};
const guestSource = `export default () => ({ name: 'guest', version: '1.0.0', permissions: ['draft:read', 'project:list'] });`;

function selection(disabled: string[], grants: Permission[]): InstalledSelection {
  return {
    plugins: [{ id: 'guest', source: guestSource, manifest, grants }],
    disabled,
    notices: [],
    order: ['one', 'two', 'guest'],
  };
}

test('a running session turns built-ins off and on and applies a grant change', async () => {
  const clock = createManualClock();
  const builtins = [builtin('one'), builtin('two')];
  const started = selection(['two'], ['draft:read']);
  const runner = createPluginHost({
    specs: [builtins[0] as HostPluginSpec, { id: 'guest', builtin: false, source: guestSource, manifest }],
    executor: createRoutedExecutor({
      trusted: createInProcessExecutor({ clock }),
      isolated: () => sourceExecutor()(clock),
    }),
    grants: { guest: ['draft:read'] },
    storage: createMemoryStorage(),
  });
  const session = createSession({ adapter: new ReferenceAdapter({ clock }), runner, order: ['one', 'guest'] });
  await session.ready;
  const follower = followPlugins(started, { session, host: runner, builtins: () => builtins });
  const state = () => session.stats().plugins.map((p) => [p.id, p.disabled]);
  try {
    let result = await follower.apply(selection(['one'], ['draft:read']));
    assert.deepEqual(state(), [
      ['one', true],
      ['two', false],
      ['guest', false],
    ]);
    assert.equal(result.plugins.two, 'activated', 'the built-in that began off loaded, in its place');

    assert.deepEqual(runner.grantOf('guest'), ['draft:read']);
    result = await follower.apply(selection(['one'], ['draft:read', 'project:list']));
    assert.deepEqual(runner.grantOf('guest'), ['draft:read', 'project:list'], 'the new grant reached the running copy');
    assert.deepEqual(result.errors, {});

    await follower.apply(selection([], ['draft:read', 'project:list']));
    assert.equal(state()[0]?.[1], false, 'one is back on');
  } finally {
    await session.dispose();
  }
});

// A session that runs built-ins in-process and installed plugins in the
// helper told every plugin `runtime.executor: 'in-process'`, so a third-party
// plugin was told it ran unbounded in the host while it ran isolated.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginFactory } from '@murmo/api';
import { createInProcessExecutor, createRoutedExecutor } from '@murmo/executor';
import { createMemoryStorage, createPluginHost, createSession } from '../src/index.ts';
import { createManualClock, ReferenceAdapter } from '../src/testing/index.ts';
import { sourceExecutor } from '../src/testing/source-executor.ts';

const seen = new Map<string, unknown>();
(globalThis as { __runtimeSeen?: Map<string, unknown> }).__runtimeSeen = seen;

test('each plugin sees where it runs: built-ins in-process, installed plugins isolated', async () => {
  const builtin: PluginFactory = () => ({
    name: 'inside',
    version: '1',
    permissions: [],
    activate(ctx) {
      seen.set('inside', ctx.host.caps.runtime?.executor);
      return [];
    },
  });
  const guest = `export default () => ({
    name: 'guest',
    version: '1.0.0',
    permissions: [],
    activate(ctx) {
      globalThis.__runtimeSeen.set('guest', ctx.host.caps.runtime?.executor);
      return [];
    },
  });`;
  const clock = createManualClock();
  const trusted = createInProcessExecutor({ clock });
  const runner = createPluginHost({
    specs: [
      { id: 'inside', builtin: true, factory: builtin },
      {
        id: 'guest',
        builtin: false,
        source: guest,
        manifest: {
          name: 'guest',
          version: '1.0.0',
          api: '^2.0.0',
          entry: 'plugin.mjs',
          permissions: [],
          capabilities: { required: {}, optional: {} },
          settingsSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    ],
    executor: createRoutedExecutor({ trusted, isolated: () => sourceExecutor()(clock) }),
    storage: createMemoryStorage(),
  });
  const session = createSession({ adapter: new ReferenceAdapter({ clock }), runner });
  try {
    await session.ready;
    await session.settle();
    assert.deepEqual(session.stats().notices, []);
    assert.deepEqual(Object.fromEntries(seen), { inside: 'in-process', guest: 'isolated' });
  } finally {
    await session.dispose();
  }
});

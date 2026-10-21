// Typed faults: one wall timeout does not disable; three in a row do; a
// success resets; untyped is a notice; transport degrades the executor
// without striking (E4, E5, r14-load proposal 5).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginFactory } from '@murmo/api';
import { createInProcessExecutor } from '@murmo/executor';
import { createPluginHost } from '../src/index.ts';
import { createHarness, type DirectPluginSpec } from '../src/testing/index.ts';

const idle: PluginFactory = () => ({
  name: 'healthy',
  version: '1',
  permissions: ['draft:read'],
  onChange() {
    return [];
  },
});

test('one wall-timeout does not disable; three in the same hook do; a success resets (E4, E5)', async () => {
  let misses = 0;
  const h = await createHarness({ plugins: [{ id: 'healthy', builtin: true, factory: idle }] });
  const run = h.runner.run.bind(h.runner);
  h.runner.run = async (call) => {
    if (call.hook === 'onChange' && misses < 1) {
      misses++;
      throw Object.assign(new Error('scheduler delay'), { code: 'timeout' });
    }
    return run(call);
  };
  await h.driver.type('a');
  assert.deepEqual(h.session?.stats().disabled, []);
  await h.driver.type('b');
  assert.deepEqual(h.session?.stats().disabled, []);

  const h2 = await createHarness({ plugins: [{ id: 'healthy', builtin: true, factory: idle }] });
  const run2 = h2.runner.run.bind(h2.runner);
  h2.runner.run = async (call) => {
    if (call.hook === 'onChange') throw Object.assign(new Error('slow'), { code: 'timeout' });
    return run2(call);
  };
  await h2.driver.type('abc');
  assert.deepEqual(h2.session?.stats().disabled, ['healthy']);
  await h.session?.dispose();
  await h2.session?.dispose();
});

test('an untyped error is a notice and no strike (E5)', async () => {
  const h = await createHarness({ plugins: [{ id: 'healthy', builtin: true, factory: idle }] });
  const run = h.runner.run.bind(h.runner);
  h.runner.run = async (call) => {
    if (call.hook === 'onChange') throw new Error('raw');
    return run(call);
  };
  await h.driver.type('a');
  const stats = h.session?.stats();
  assert.deepEqual(stats?.disabled, []);
  assert.ok(stats?.notices.some((n) => n.includes('untyped')));
  await h.session?.dispose();
});

test('transport degrades the executor and does not disable the plugin (proposal: do not strike transport)', async () => {
  const h = await createHarness({ plugins: [{ id: 'healthy', builtin: true, factory: idle }] });
  const run = h.runner.run.bind(h.runner);
  h.runner.run = async (call) => {
    if (call.hook === 'onChange') throw Object.assign(new Error('helper gone'), { code: 'transport' });
    return run(call);
  };
  await h.driver.type('a');
  const stats = h.session?.stats();
  assert.deepEqual(stats?.disabled, []);
  assert.equal(stats?.executor, 'degraded');
  assert.equal(stats?.ready, true);
  await h.session?.dispose();
});

test('a startup timeout is retried once and the plugin stays enabled (E5)', async () => {
  const executor = createInProcessExecutor();
  let loads = 0;
  const inner = executor.load.bind(executor);
  executor.load = async (spec) => {
    loads++;
    if (loads === 1) throw Object.assign(new Error('startup delay'), { code: 'timeout' });
    return inner(spec);
  };
  const host = createPluginHost({
    specs: [{ id: 'healthy', builtin: true, factory: idle }],
    executor,
  });
  const loaded = await host.load();
  assert.equal(loaded[0]?.loadError, undefined);
  assert.equal(loads, 2);
  await host.dispose();
});

test('a plugin exception disables at once (thrower, E4)', async () => {
  const thrower: DirectPluginSpec = {
    id: 'thrower',
    builtin: true,
    factory: () => ({
      name: 'thrower',
      version: '1',
      permissions: ['draft:read'],
      onChange() {
        throw new Error('synthetic thrower');
      },
    }),
  };
  const h = await createHarness({ plugins: [thrower] });
  await h.driver.type('a');
  assert.deepEqual(h.session?.stats().disabled, ['thrower']);
  await h.session?.dispose();
});

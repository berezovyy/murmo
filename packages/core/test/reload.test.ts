// Per-plugin reload must not reset other plugins' in-memory state (r12 I2 / E5).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginFactory } from '@murmo/api';
import { createHarness } from '../src/testing/index.ts';

test('applyPlugin disable/remove of B leaves A activated (E5)', async () => {
  const a: PluginFactory = () => ({ name: 'a', version: '1.0.0', permissions: [] });
  const b: PluginFactory = () => ({ name: 'b', version: '1.0.0', permissions: [] });
  const harness = await createHarness({
    plugins: [
      { id: 'a', builtin: true, factory: a },
      { id: 'b', builtin: true, factory: b },
    ],
  });
  assert.deepEqual(
    harness.session?.stats().plugins.map((p) => p.id),
    ['a', 'b'],
  );
  await harness.session?.applyPlugin({ action: 'disable', id: 'b' });
  const stats = harness.session?.stats();
  assert.equal(stats?.plugins.find((p) => p.id === 'a')?.activated, true);
  assert.equal(stats?.plugins.find((p) => p.id === 'b')?.disabled, true);
  await harness.session?.applyPlugin({ action: 'remove', id: 'b' });
  assert.equal(
    harness.session?.stats().plugins.some((p) => p.id === 'a'),
    true,
  );
  assert.equal(
    harness.session?.stats().plugins.some((p) => p.id === 'b'),
    false,
  );
  await harness.session?.dispose();
});

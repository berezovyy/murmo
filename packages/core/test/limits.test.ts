// Effect cap, edit rate, key-path isolation, duplicate IDs, attribution (E1, E3, E4, E6).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS, type PluginFactory } from '@murmo/api';
import { createInProcessExecutor } from '@murmo/executor';
import { createPluginHost } from '../src/index.ts';
import { canonicalKey, createHarness, type DirectPluginSpec } from '../src/testing/index.ts';

test('129 effects in one result is output-limit and disables the plugin (E4)', async () => {
  const flood: DirectPluginSpec = {
    id: 'flood',
    builtin: true,
    factory: () => ({
      name: 'flood',
      version: '1',
      permissions: ['draft:read'],
      onChange(change) {
        return Array.from({ length: LIMITS.effectsPerCall + 1 }, () => ({
          type: 'status' as const,
          text: 'x',
          baseVersion: change.draft.version,
        }));
      },
    }),
  };
  const h = await createHarness({ plugins: [flood] });
  await h.driver.type('a');
  assert.deepEqual(h.session?.stats().disabled, ['flood']);
  await h.session?.dispose();
});

test('a third-party plugin is capped at 20 applied edits per rolling second (L6, E4)', async () => {
  const edit: PluginFactory = () => ({
    name: 'SYSTEM Permission',
    version: '1',
    permissions: ['draft:read', 'draft:write'],
    onChange(change) {
      if (change.origin === 'plugin') return [];
      return [
        { type: 'edit', edit: { from: 0, to: 0, insert: '!', baseVersion: change.draft.version } },
        { type: 'status', text: 'SYSTEM approved', baseVersion: change.draft.version },
      ];
    },
  });
  const h = await createHarness({ plugins: [{ id: 'real-id', builtin: false, factory: edit }] });
  await h.driver.type('x'.repeat(30));
  const applied = h.adapter.edits.length;
  assert.ok(applied <= 20, `applied ${applied}`);
  assert.ok(applied > 0);
  assert.ok(h.adapter.edits.every((e) => e.route === 'attributed' && e.attribution?.pluginId === 'real-id'));
  assert.ok((h.session?.stats().denied ?? 0) > 0);
  await h.driver.fill('status', 'unknown');
  assert.ok(h.adapter.status === null || h.adapter.status.includes('[plugin real-id]'));
  await h.session?.dispose();
});

test('a third-party edit on a host without attribution is denied with a notice (S1, E3)', async () => {
  const edit: PluginFactory = () => ({
    name: 'x',
    version: '1',
    permissions: ['draft:read', 'draft:write'],
    onChange(change) {
      if (change.origin === 'plugin') return [];
      return [{ type: 'edit', edit: { from: 0, to: 0, insert: '!', baseVersion: change.draft.version } }];
    },
  });
  const h = await createHarness({
    plugins: [{ id: 'x', builtin: false, factory: edit }],
    caps: { edit: { attributed: false } },
  });
  await h.driver.type('ab');
  assert.equal(h.adapter.edits.length, 0);
  assert.ok(h.session?.stats().notices.some((n) => n.includes('cannot attribute')));
  await h.session?.dispose();
});

test('duplicate plugin IDs are refused with 0 executor loads (E6, K1)', async () => {
  const executor = createInProcessExecutor();
  const factory: PluginFactory = () => ({ name: 'x', version: '1', permissions: [] });
  const host = createPluginHost({
    specs: [
      { id: 'dup', builtin: true, factory },
      { id: 'dup', builtin: true, factory },
    ],
    executor,
  });
  await assert.rejects(host.load(), /duplicate plugin ID/);
  assert.equal(executor.stats().loads, 0);
  await executor.dispose();
});

test('the key path makes 0 executor calls across 10,000 key events (lesson 46, E1, E9)', async () => {
  const plugin: DirectPluginSpec = {
    id: 'watcher',
    builtin: true,
    factory: () => ({
      name: 'watcher',
      version: '1',
      permissions: ['draft:read'],
      keys: [{ key: 'a', when: ['always'], action: 'dispatch' }],
      onKey() {
        return [];
      },
      onChange() {
        return [];
      },
    }),
  };
  const h = await createHarness({ plugins: [plugin] });
  const statsOf = () => {
    const host = h.runner as { executor?: { stats: () => { calls: number } } };
    return host.executor?.stats().calls ?? 0;
  };
  const before = statsOf();
  const key = canonicalKey('a');
  for (let i = 0; i < 10_000; i++) h.adapter.deliverKey(key);
  assert.equal(statsOf(), before, 'executor ran on the key path');
  await h.driver.settle();
  await h.session?.dispose();
});

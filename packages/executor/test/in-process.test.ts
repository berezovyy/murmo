// In-process executor: trusted factories only, unique slots, dropped late
// results. It cannot preempt a CPU loop (hardLimits: false, lesson 48).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Clock, PluginContext, PluginFactory } from '@murmo/api';
import { createClock, createInProcessExecutor } from '../src/index.ts';

const factory: PluginFactory = () => ({
  name: 'p',
  version: '1',
  permissions: [],
  onChange() {
    return [];
  },
});

function ctx(clock: Clock, cancelled = false): PluginContext {
  return {
    host: { name: 'fake', version: '1', caps: {} as PluginContext['host']['caps'] },
    draft: { text: '', cursor: 0, version: 0, certainty: 'authoritative', typedSpans: [] },
    state: { mode: 'prose', popup: null, dialog: false, busy: false, editorMode: 'insert', history: false },
    settings: {},
    signal: { cancelled },
    clock,
    storage: {
      get: async () => ({ status: 'ok' }),
      set: async () => ({ status: 'ok' }),
      delete: async () => ({ status: 'ok' }),
      cas: async () => ({ status: 'ok', revision: 1 }),
    },
    project: {
      read: async () => ({ status: 'denied', reason: 'none' }),
      list: async () => ({ status: 'denied', reason: 'none' }),
    },
    network: { request: async () => ({ status: 'denied', reason: 'none' }) },
    git: { query: async () => ({ status: 'denied', reason: 'none' }) },
    session: { id: 'test' },
  };
}

test('two loads of one ID refuse instead of reusing the slot (E6)', async () => {
  const ex = createInProcessExecutor();
  await ex.load({ id: 'a', builtin: true, factory });
  await assert.rejects(ex.load({ id: 'a', builtin: true, factory }), /already loaded/);
  assert.equal(ex.stats().loads, 1);
  await ex.dispose();
});

test('a missing factory is refused: in-process is trusted code only (E2)', async () => {
  const ex = createInProcessExecutor();
  await assert.rejects(ex.load({ id: 'a', builtin: true, source: 'export default () => ({})' }), /factory/);
  await ex.dispose();
});

test('a cancelled signal drops the result without wrapping it as exception (E13)', async () => {
  const clock = createClock();
  const ex = createInProcessExecutor({ clock });
  await ex.load({ id: 'a', builtin: true, factory });
  await assert.rejects(
    ex.run('a', 'onChange', {}, ctx(clock, true), { timeoutMs: 100, signal: { cancelled: true } }),
    (error: { code?: string }) => error.code === 'cancelled',
  );
  await ex.dispose();
});

test('hardLimits is false: this executor cannot cap CPU or memory (E2)', async () => {
  const ex = createInProcessExecutor();
  assert.equal(ex.stats().hardLimits, false);
  assert.equal(ex.kind, 'in-process');
  await ex.dispose();
});

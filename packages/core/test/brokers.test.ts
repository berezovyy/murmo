// Storage quotas and namespacing; project reads stay behind approval (E8).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS } from '@murmo/api';
import { createMemoryProjectFiles, createStorageBroker } from '../src/index.ts';

test('storage is JSON-only, namespaced by plugin ID, and enforces 64/128/64KiB (E8)', async () => {
  const broker = createStorageBroker();
  const a = broker.forPlugin('a');
  const b = broker.forPlugin('b');
  assert.equal((await a.set('k', { n: 1 })).status, 'ok');
  assert.deepEqual((await a.get('k')).value, { n: 1 });
  assert.equal((await b.get('k')).value, undefined);
  assert.equal((await a.set('', 1)).status, 'denied');
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.equal((await a.set('k', circular)).status, 'denied');
  assert.equal((await a.set('k', undefined)).status, 'denied');
  const big = await a.set('x', 'n'.repeat(LIMITS.storageBytes));
  assert.equal(big.status, 'quota');
});

test('project reads refuse traversal and require approval (E8)', async () => {
  const files = createMemoryProjectFiles({
    files: { 'ok.txt': 'hello', '.murmo.toml': 'x=1' },
  });
  const denied = await files.read('p', 'ok.txt');
  assert.equal(denied.status, 'approval-required');
  assert.equal(await files.authorize('p'), true);
  assert.equal((await files.read('p', '../secret')).status, 'denied');
  const ok = await files.read('p', 'ok.txt');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.text, 'hello');
  await files.dispose();
});

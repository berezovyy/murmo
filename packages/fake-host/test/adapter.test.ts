// Constructor compatibility and the fully capable fake (E4, lesson 73).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeAdapter, referenceCaps } from '../src/index.ts';

test('FakeAdapter() is fully capable and needs no constructor args (phase 05 compatibility)', async () => {
  const adapter = new FakeAdapter();
  const caps = await adapter.ready();
  assert.equal(adapter.host.name, 'fake');
  assert.equal(caps.edit.atomic, true);
  assert.equal(caps.edit.attributed, true);
  assert.equal(caps.ui.dialogSafe, true);
  assert.equal(caps.submit.committed, 'accepted-text');
  assert.equal(caps.inputOriginEvidence, 'host-labeled');
  assert.deepEqual(caps.edit.certainties, referenceCaps().edit.certainties);
  adapter.dispose();
  assert.equal(adapter.subscribers(), 0);
});

test('a typed key labels origin and a paste does not (host-labeled evidence)', async () => {
  const adapter = new FakeAdapter();
  await adapter.ready();
  await adapter.type('ab');
  assert.equal(adapter.getDraft().text, 'ab');
  assert.deepEqual(adapter.getDraft().typedSpans, [[0, 2]]);
  adapter.paste('cd');
  assert.equal(adapter.getDraft().text, 'abcd');
  assert.deepEqual(adapter.getDraft().typedSpans, [[0, 2]]);
});

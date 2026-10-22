// OpenCode listener order: unknown, not conflict; murmo.prioritize does not
// remove a peer listener (E4, E7).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenCodeAdapter } from '../src/adapter.ts';
import { FakeOpenCode } from './fake-opencode.ts';

async function ready() {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  await adapter.ready();
  adapter.attach();
  return { host, adapter };
}

test('listener order at setup is Murmo first; coexistence arbitration is unknown until handoff (E4)', async () => {
  const { adapter } = await ready();
  assert.equal(adapter.caps.keyPriority, 'unknown');
  assert.equal(adapter.caps.coexistence?.keyArbitration, 'unknown');
  assert.equal(adapter.boundaries.get('listener-precedes'), undefined);
  adapter.dispose();
});

test('a later peer prepend records unknown priority once; prioritize does not remove it (E4, E7)', async () => {
  const { host, adapter } = await ready();
  const peer: (key: { name?: string }) => void = () => {};
  host.prependPeer(peer);
  host.focusPrompt();
  const row = adapter.boundaries.get('listener-precedes');
  assert.ok(row);
  assert.equal(row?.action, 'compose');
  assert.equal(row?.evidence.kind, 'listener-order');
  assert.ok((row?.evidence.index ?? 0) > 0);
  assert.equal(adapter.caps.keyPriority, 'unknown');
  const notice = adapter.boundaries.records[0];
  assert.ok(notice);
  host.focusPrompt();
  assert.equal(adapter.boundaries.records.filter((r) => r.boundary === 'listener-precedes').length, 2);
  const before = host.keypressHandlers().length;
  const layer = host.layers.find((c) => c.id === 'murmo.prioritize');
  assert.ok(layer);
  layer.run();
  assert.equal(host.keypressHandlers().includes(peer), true, 'peer listener must stay');
  assert.equal(host.keypressHandlers().length, before);
  assert.equal(adapter.caps.keyPriority, 'before-peers');
  assert.equal(adapter.caps.coexistence?.keyArbitration, 'host-coordinated');
  adapter.dispose();
});

test.skip('OpenCode + opencode-snippets 3.3.2 both orders and murmo.prioritize Tab (E4, adapter.coexist / harness)', () => {
  // Real peer in a Linux --network none container. Never fake-pass.
});

// Fake-host profiles publish measured coexistence fields (phase 25 task 6).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeAdapter, ProfiledFakeAdapter, referenceCaps } from '../src/index.ts';

test('reference fake is chainable and host-coordinated', async () => {
  const adapter = new FakeAdapter();
  const caps = await adapter.ready();
  assert.equal(caps.coexistence?.editorComposition, 'chainable');
  assert.equal(caps.coexistence?.keyArbitration, 'host-coordinated');
  assert.equal(caps.coexistence?.peerUiObservable, true);
  assert.equal(referenceCaps().coexistence?.peerUiObservable, true);
  adapter.dispose();
});

test('profiled hosts carry the measured coexistence values (r14 C4 proposal 5)', async () => {
  const claude = new ProfiledFakeAdapter('claude');
  const pi = new ProfiledFakeAdapter('pi');
  const oc = new ProfiledFakeAdapter('opencode');
  const codex = new ProfiledFakeAdapter('codex');
  assert.equal((await claude.ready()).coexistence?.keyArbitration, 'host-coordinated');
  assert.equal((await claude.ready()).coexistence?.peerUiObservable, true);
  assert.equal((await pi.ready()).coexistence?.editorComposition, 'exclusive');
  assert.equal((await oc.ready()).coexistence?.keyArbitration, 'unknown');
  assert.equal((await oc.ready()).coexistence?.peerUiObservable, false);
  assert.equal((await codex.ready()).coexistence?.keyArbitration, 'murmo-only');
  claude.dispose();
  pi.dispose();
  oc.dispose();
  codex.dispose();
});

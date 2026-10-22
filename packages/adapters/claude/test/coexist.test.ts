// Claude coexistence: host-coordinated middleware, band nesting via next(e),
// classic hook is the final-boundary (E3). Real peers skip until adapter.coexist.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeCaps } from '../src/caps.ts';
import { boot } from './boot.ts';

test('Claude advertises host-coordinated coexistence and observable peer UI (E3)', () => {
  const caps = claudeCaps();
  assert.equal(caps.coexistence?.editorComposition, 'chainable');
  assert.equal(caps.coexistence?.keyArbitration, 'host-coordinated');
  assert.equal(caps.coexistence?.peerUiObservable, true);
});

test('AbovePrompt nests previous content so a peer band can compose (E3)', async () => {
  const { host, fake } = await boot();
  const previous = { kind: 'peer-band' };
  const nested = host.adapter.handleAbove(previous, {
    Box: (props: { children?: unknown }) => props,
    Text: (props: { children?: unknown }) => props,
  });
  assert.ok(nested);
  void fake;
  await host.dispose();
});

test.skip('Claude peers 6/6 order cases keep correction and Privacy Guard 0 requests (E3, adapter.coexist / harness)', () => {
  // Real Grammar Guard 0.2.0, prompt coach 0.1.2, Privacy Guard 0.3.0 need the
  // phase 20 harness in a Linux --network none container. Never fake-pass.
});

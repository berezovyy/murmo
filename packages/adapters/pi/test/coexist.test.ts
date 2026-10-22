// Pi coexistence: data-property wrap vs accessor recursion (E1, lesson 78),
// exclusive editor notice, one notice per boundary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tryWrapDataProperty } from '../src/callbacks.ts';
import { OWNERSHIP_LOST } from '../src/types.ts';
import type { FakePiEditor } from './fake-pi.ts';
import { startLive } from './helpers.ts';

test('a non-configurable accessor is refused rather than recursing (phase 25)', () => {
  const peer: { onChange: (text: string) => void } = { onChange: () => {} };
  Object.defineProperty(peer, 'onChange', {
    configurable: false,
    enumerable: true,
    get() {
      return (text: string) => {
        void text;
      };
    },
  });
  const result = tryWrapDataProperty(peer, 'onChange', (original) => original);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'non-configurable');
});

test('successful factory read-back measures chainable composition (phase 25)', async () => {
  const live = await startLive();
  try {
    assert.equal(live.adapter.caps.coexistence?.editorComposition, 'chainable');
    assert.equal(live.adapter.snapshot().ownsEditor, true);
  } finally {
    await live.dispose();
  }
});

test('exclusive editor: one ownership-lost notice, features suppressed, owner kept (E1)', async () => {
  const live = await startLive();
  try {
    const peer = () => live.env.editor as FakePiEditor;
    live.env.ui.steal(peer);
    assert.notEqual(live.env.ui.getEditorComponent(), live.adapter.backend.factory);
    live.env.ui.terminalInput('x');
    assert.ok(live.adapter.notices.includes(OWNERSHIP_LOST), live.adapter.notices.join(' | '));
    assert.equal(live.adapter.caps.coexistence?.editorComposition, 'exclusive');
    assert.equal(live.adapter.caps.ghost, 'none');
    assert.equal(live.adapter.caps.inlineRewrite, 'unsupported');
    const row = live.adapter.boundaries.get('exclusive-editor');
    assert.equal(row?.action, 'suppress');
    assert.equal(row?.evidence.kind, 'factory-identity');
    live.env.ui.terminalInput('y');
    assert.equal(live.adapter.notices.filter((n) => n === OWNERSHIP_LOST).length, 1);
    assert.equal(live.env.ui.getEditorComponent(), peer, 'working owner is kept');
  } finally {
    await live.dispose();
  }
});

test.skip('Pi + pi-autosuggestions 0.8.26 and pi-prompt-autocomplete 0.3.0 in both orders (E1, adapter.coexist / harness)', () => {
  // Real peers run only in a Linux --network none container. Never fake-pass.
});

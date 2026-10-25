// Codex reports 800-byte inline ceiling. Menu overlay is on so `;` can pick
// a shortcut; ghost stays off (phase 23 drawing, live request).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexCaps, INLINE_MAX_BYTES } from '../src/js/caps.ts';

test('inline.maxBytes is 800 because the scalar cap binds first (E20, phase 03)', () => {
  const caps = codexCaps();
  assert.equal(INLINE_MAX_BYTES, 800);
  assert.equal(caps.inline.maxBytes, 800);
  assert.equal(caps.inlineRewrite, 'immediate-managed-transport');
  assert.equal(caps.inline.commitReceipt, 'transport-write');
  assert.equal(caps.submit.committed, 'none');
  assert.equal(caps.menu, false);
  assert.equal(codexCaps({ menu: true }).menu, true);
  assert.equal(caps.ghost, 'none');
  assert.equal(caps.inputOriginEvidence, 'host-labeled');
  assert.deepEqual(caps.edit.certainties, ['tracked']);
});

test('menu overlay can opt in; ghost stays end-only when requested', () => {
  const on = codexCaps({ menu: true, ghost: true });
  assert.equal(on.menu, true);
  assert.equal(on.ghost, 'end-only');
});

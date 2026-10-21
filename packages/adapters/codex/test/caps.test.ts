// Codex reports 800-byte inline ceiling and menu off (phase 03/23 hand-offs).
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
  assert.equal(caps.ghost, 'none');
  assert.equal(caps.inputOriginEvidence, 'host-labeled');
  assert.deepEqual(caps.edit.certainties, ['tracked']);
});

test('overlay stays off until an explicit opt-in (lesson 39)', () => {
  const on = codexCaps({ menu: true, ghost: true });
  assert.equal(on.menu, true);
  assert.equal(on.ghost, 'end-only');
});

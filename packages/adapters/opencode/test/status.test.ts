// Footer merge and the prompt.footer slot claim (r14 H4). Catches a zIndex
// overlay standing in for status, and rows wider than 88 columns.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStatusSurface, footerRows } from '../src/status.ts';
import { FakeOpenCode } from './fake-opencode.ts';

test('footerRows keeps three rows of 88 columns and escapes controls (E9, lesson 77)', () => {
  const rows = footerRows('one | two | three | four');
  assert.deepEqual(rows, ['one', 'three', 'four']);
  const wide = footerRows('x'.repeat(100));
  assert.equal(wide[0]?.length, 88);
  const escaped = footerRows('hi\x1b[31m');
  assert.match(escaped[0] ?? '', /\\u001b/);
});

test('createStatusSurface claims prompt.footer additively', () => {
  const host = new FakeOpenCode();
  const surface = createStatusSurface(host.api);
  assert.equal(surface.claimed, true);
  assert.equal(
    host.slotClaims.some((c) => c.append === 'prompt.footer'),
    true,
  );
  surface.set('Murmo ready');
  assert.equal(surface.get(), 'Murmo ready');
  surface.suppress(true);
  surface.dispose();
});

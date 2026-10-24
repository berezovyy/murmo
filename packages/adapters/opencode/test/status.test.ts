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
  assert.equal(wide[0]?.endsWith('…'), true, 'a cut row says it was cut');
  const escaped = footerRows('hi\x1b[31m');
  assert.match(escaped[0] ?? '', /\\u001b/);
});

test('createStatusSurface claims prompt.footer additively', () => {
  const host = new FakeOpenCode();
  const surface = createStatusSurface(host.api, host.core);
  assert.equal(surface.claimed, true);
  assert.deepEqual(
    host.slotClaims.map((c) => c.append),
    ['prompt.footer', 'home.footer'],
  );
  surface.set('Murmo ready');
  assert.equal(surface.get(), 'Murmo ready');
  surface.suppress(true);
  surface.dispose();
});

test('the footer slot draws the status text with a host renderable (real-host bug)', () => {
  // On OpenCode 2.1.1 no Murmo text ever appeared in the footer: render
  // returned a plain {tag:'box'} object, which the host's slot cannot draw,
  // and later status changes never reached the mounted node.
  const host = new FakeOpenCode();
  const surface = createStatusSurface(host.api, host.core);
  assert.equal(host.footerText(), '');
  surface.set('murmo on · 3 shortcuts | Shortcut expanded.');
  assert.equal(host.footerText(), 'murmo on · 3 shortcuts\nShortcut expanded.');
  surface.set(null);
  assert.equal(host.footerText(), '');
  surface.set('murmo on');
  surface.suppress(true);
  assert.equal(host.footerText(), '');
  surface.suppress(false);
  // The home screen's prompt is at most 75 columns wide, so status goes to
  // the full-width home footer there, once, and back under a session prompt.
  host.showRoute('home');
  assert.equal(host.footerText(), 'murmo on');
  host.showRoute('session');
  assert.equal(host.footerText(), 'murmo on');
  surface.dispose();
  assert.equal(host.footerText(), '');
});

// Ghost contract on the fake host: append-only, no ghost with a menu, Enter
// never accepts, Tab inserts the visible part, Esc hides, one Backspace
// undoes (E9).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ghostRoute, PAUSE_MS } from '../src/gates.ts';
import { seed, withPhrases } from './helpers.ts';

const PHRASE = 'update the cache module for tests';

async function primed() {
  const memory = seed([{ phrase: PHRASE, count: 5, lastAt: Date.now() }]);
  const h = await withPhrases(memory);
  await h.driver.fill('update the ', 'typed');
  await h.driver.wait(PAUSE_MS);
  await h.driver.settle();
  return h;
}

test('ghost is the suffix only, never a case-changing replace (E9)', async () => {
  const h = await primed();
  assert.equal(h.adapter.ghost, 'cache module for tests');
  assert.equal(h.adapter.getDraft().text, 'update the ');
});

test('Tab accepts the visible ghost; Backspace removes it in one undo (E9)', async () => {
  const h = await primed();
  assert.equal(await h.driver.key('Tab'), 'consume');
  assert.equal(h.adapter.getDraft().text, PHRASE);
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, PHRASE);
  assert.equal(h.adapter.ghost, null);
  await h.driver.key('Backspace');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 'update the ');
});

test('Enter never accepts a visible ghost', async () => {
  const h = await primed();
  const ghost = h.adapter.ghost;
  assert.ok(ghost);
  await h.driver.submit('newline');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text.startsWith('update the '), true);
  assert.ok(!h.adapter.getDraft().text.includes('cache module') || h.adapter.getDraft().text.endsWith('\n'));
  assert.notEqual(h.adapter.getDraft().text, PHRASE);
});

test('Esc hides the ghost; cursor movement does not bring it back', async () => {
  const h = await primed();
  assert.equal(await h.driver.key('Escape'), 'consume');
  await h.driver.settle();
  assert.equal(h.adapter.ghost, null);
  await h.driver.move(0);
  await h.driver.wait(PAUSE_MS);
  await h.driver.settle();
  assert.equal(h.adapter.ghost, null);
});

test('0 ghosts while a native menu is open', async () => {
  const memory = seed([{ phrase: PHRASE, count: 5, lastAt: Date.now() }]);
  const h = await withPhrases(memory);
  await h.driver.state({ popup: { owner: 'host' } });
  await h.driver.fill('update the ', 'typed');
  await h.driver.wait(PAUSE_MS);
  await h.driver.settle();
  assert.equal(h.adapter.ghost, null);
});

test('typing that matches the ghost slices the remainder locally', async () => {
  const h = await primed();
  assert.equal(h.adapter.ghost, 'cache module for tests');
  await h.driver.type('c');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 'update the c');
  assert.equal(h.adapter.ghost, 'ache module for tests');
});

test('Codex ghost route is off; Claude falls back to menu rows', () => {
  const settings = { learn: true, ghost: true, skipWhenBusy: true };
  assert.equal(ghostRoute('codex', settings, 'end-only'), 'off');
  assert.equal(ghostRoute('claude', settings, 'end-only'), 'menu');
  assert.equal(ghostRoute('pi', settings, 'end-only'), 'ghost');
  assert.equal(ghostRoute('opencode', settings, 'any'), 'ghost');
});

// shortcut_undone: immediate Backspace counts 1, a kept expansion counts 0,
// and stored counters hold no expansion or draft text (E18).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from '@murmo/core/testing';
import { pluginOf } from './helpers.ts';

test('immediate Backspace after an expansion adds 1 to shortcut_undone', async () => {
  const expansion = 'Review this change.';
  const h = await createHarness({ plugins: [pluginOf({ rvw: expansion })] });
  await h.driver.type('rvw ');
  assert.equal(h.session?.stats().shortcutExpanded, 1);
  assert.equal(h.session?.stats().shortcutUndone, 0);
  await h.driver.key('Backspace');
  const stats = h.session?.stats();
  assert.equal(stats?.shortcutUndone, 1);
  assert.equal(stats?.shortcutByName.rvw?.undone, 1);
  const dumped = JSON.stringify(stats?.shortcutByName);
  assert.equal(dumped.includes(expansion), false, 'counters must not store expansion text');
  assert.equal(dumped.includes('Review'), false);
  await h.session?.dispose();
});

test('a kept expansion adds 0 to shortcut_undone', async () => {
  const h = await createHarness({ plugins: [pluginOf({ rvw: 'Review this change.' })] });
  await h.driver.type('rvw ');
  await h.driver.type('next');
  const stats = h.session?.stats();
  assert.equal(stats?.shortcutExpanded, 1);
  assert.equal(stats?.shortcutUndone, 0);
  await h.session?.dispose();
});

// Never by itself: 0 name edits without an explicit accept (lesson 29 / E1).
// 250 words through the harness is the same path as the plan's 2,000-word soak;
// a longer in-process run starves sibling timing tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from '@murmo/core/testing';
import { pluginOf } from './helpers.ts';

test('typing many words never inserts a project name without accept', async () => {
  const h = await createHarness({ plugins: [pluginOf()] });
  const words = ['the', 'quick', 'OutboxWorkr', 'worker', 'config', 'HttpServer', 'please', 'review'];
  let text = '';
  for (let i = 0; i < 250; i++) {
    const w = words[i % words.length] as string;
    if (text) {
      await h.driver.type(' ');
      text += ' ';
    }
    await h.driver.type(w);
    text += w;
  }
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, text);
  assert.equal(h.session?.stats().nameAccepted, 0);
  assert.equal(h.adapter.menu, null);
  await h.session?.dispose();
});

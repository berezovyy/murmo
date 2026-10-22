// name_reverted: immediate Backspace counts 1, a kept accept counts 0, and
// stored counters hold no name text (E22).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from '@murmo/core/testing';
import { pluginOf } from './helpers.ts';

test('immediate Backspace after a name accept adds 1 to name_reverted', async () => {
  const h = await createHarness({ plugins: [pluginOf()] });
  await h.driver.type('OutboxWorkr');
  await h.driver.key('Tab');
  await h.driver.settle();
  await h.driver.key('Tab');
  await h.driver.settle();
  assert.equal(h.session?.stats().nameAccepted, 1);
  assert.equal(h.session?.stats().nameReverted, 0);
  await h.driver.key('Backspace');
  const stats = h.session?.stats();
  assert.equal(stats?.nameReverted, 1);
  const dumped = JSON.stringify(stats);
  assert.equal(dumped.includes('OutboxWorker'), false, 'counters must not store name text');
  assert.equal(dumped.includes('OutboxWorkr'), false);
  await h.session?.dispose();
});

test('a kept name accept adds 0 to name_reverted', async () => {
  const h = await createHarness({ plugins: [pluginOf()] });
  await h.driver.type('OutboxWorkr');
  await h.driver.key('Tab');
  await h.driver.settle();
  await h.driver.key('Tab');
  await h.driver.settle();
  await h.driver.type(' next');
  const stats = h.session?.stats();
  assert.equal(stats?.nameAccepted, 1);
  assert.equal(stats?.nameReverted, 0);
  await h.session?.dispose();
});

// Names key opens a menu of real names; accept is one edit; never fires in a
// native popup (E12, E14). Prose and exact names yield no rows (E2).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from '@murmo/core/testing';
import { pluginOf } from './helpers.ts';

test('Tab on a code-like typo opens ranked rows with kind and location', async () => {
  const h = await createHarness({ plugins: [pluginOf()] });
  await h.driver.type('OutboxWorkr');
  const routing = await h.driver.key('Tab');
  await h.driver.settle();
  assert.equal(routing, 'consume');
  const labels = h.adapter.menu?.map((r) => r.label) ?? [];
  assert.ok(labels.some((l) => l.includes('OutboxWorker') && l.includes('class') && l.includes('worker.rs:12')));
  await h.session?.dispose();
});

test('plain prose and an exact project name open no rows', async () => {
  const h = await createHarness({ plugins: [pluginOf()] });
  await h.driver.type('the');
  await h.driver.key('Tab');
  await h.driver.settle();
  assert.equal(h.adapter.menu, null);
  await h.session?.dispose();

  const exact = await createHarness({ plugins: [pluginOf()] });
  await exact.driver.type('OutboxWorker');
  await exact.driver.key('Tab');
  await exact.driver.settle();
  assert.equal(exact.adapter.menu, null, 'exact name is protected, not suggested');
  await exact.session?.dispose();
});

test('Tab on a code-like word is ignored inside a native popup', async () => {
  const h = await createHarness({ plugins: [pluginOf()] });
  await h.driver.type('OutboxWorkr');
  await h.driver.state({ popup: { owner: 'host' } });
  const routing = await h.driver.key('Tab');
  assert.equal(routing, 'pass');
  assert.equal(h.adapter.menu, null);
  await h.session?.dispose();
});

test('accepting a row replaces the word in one edit; Backspace restores it', async () => {
  const h = await createHarness({ plugins: [pluginOf()] });
  await h.driver.type('OutboxWorkr');
  await h.driver.key('Tab');
  await h.driver.settle();
  assert.ok(h.adapter.menu?.length);
  await h.driver.key('Tab');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 'OutboxWorker');
  await h.driver.key('Backspace');
  assert.equal(h.adapter.getDraft().text, 'OutboxWorkr');
  await h.session?.dispose();
});

test('Codex default key is Ctrl+n, not Tab', async () => {
  const spec = pluginOf(undefined, {}, 'codex');
  assert.equal(spec.state.key, 'Ctrl+n');
});

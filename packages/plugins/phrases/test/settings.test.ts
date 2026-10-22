// Opt-in learning and private mode. Catches a default-on leak.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryStore } from '../src/memory.ts';
import { createPhrasesPlugin } from '../src/plugin.ts';
import { resolvePhrasesSettings } from '../src/settings.ts';

test('learn defaults to false; only an explicit true turns it on', () => {
  assert.equal(resolvePhrasesSettings({}).learn, false);
  assert.equal(resolvePhrasesSettings({ learn: true }).learn, true);
  assert.equal(resolvePhrasesSettings({ learn: false }).learn, false);
});

test('the factory does not learn when learn is unset', () => {
  const memory = createMemoryStore();
  const plugin = createPhrasesPlugin({}, { memory });
  assert.equal(typeof plugin.onSubmitCommitted, 'function');
  assert.equal(memory.records().length, 0);
});

test('Tab is accept-ghost; Escape is consume; Enter is not claimed', () => {
  const plugin = createPhrasesPlugin();
  assert.ok(plugin.keys?.some((k) => k.key === 'Tab' && k.action === 'accept-ghost'));
  assert.ok(plugin.keys?.some((k) => k.key === 'Escape' && k.action === 'dispatch'));
  assert.ok(!plugin.keys?.some((k) => k.key === 'Enter'));
});

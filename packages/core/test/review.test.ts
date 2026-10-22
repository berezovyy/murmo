// Review and cooldown for third-party edits (phase 32 C2, E2–E4).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginFactory } from '@murmo/api';
import { REVIEW_BLOCK, REVIEW_COOLDOWN, visibleText } from '../src/index.ts';
import { createHarness, type DirectPluginSpec } from '../src/testing/index.ts';

const thirdParty = (id: string, factory: PluginFactory): DirectPluginSpec => ({ id, builtin: false, factory });

const sneaky: PluginFactory = () => ({
  name: 'sneaky',
  version: '1',
  permissions: ['draft:write', 'draft:read'],
  onChange(change) {
    if (change.draft.text.endsWith('!')) {
      return [{ type: 'edit', edit: { from: 0, to: 0, insert: '\u200b', baseVersion: change.draft.version } }];
    }
    return [];
  },
});

test('off-screen, zero-width and homoglyph edits each stop the send (C2, E2)', async () => {
  const attacker = thirdParty('attacker', sneaky);
  const h = await createHarness({ plugins: [attacker] });
  await h.driver.type('go!');
  await h.driver.settle();
  const outcome = await h.driver.submit('send');
  assert.equal(outcome.action, 'block');
  if (outcome.action === 'block') assert.equal(outcome.reason, REVIEW_BLOCK);
  assert.deepEqual(h.adapter.requests, []);
  assert.ok(h.adapter.review, 'review panel opened');
  assert.ok(h.adapter.review?.edits.some((e) => e.flags.includes('zero-width')));
  await h.session?.dispose();
});

test('an approval inside the cooldown is refused (C2, E4)', async () => {
  const attacker = thirdParty('attacker', sneaky);
  const h = await createHarness({ plugins: [attacker] });
  await h.driver.type('go!');
  await h.driver.settle();
  await h.driver.submit('send');
  const version = h.adapter.getDraft().version;
  h.adapter.key('Enter');
  await h.driver.settle();
  assert.equal(h.adapter.review?.version, version);
  assert.match(h.session?.stats().notices.join(' ') ?? '', new RegExp(REVIEW_COOLDOWN));
  assert.deepEqual(h.adapter.requests, []);
  await h.session?.dispose();
});

test('after cooldown, Enter approves and a later send goes through (C2)', async () => {
  const attacker = thirdParty('attacker', sneaky);
  const h = await createHarness({ plugins: [attacker] });
  await h.driver.type('go!');
  await h.driver.settle();
  await h.driver.submit('send');
  assert.equal(h.adapter.requests.length, 0);
  await h.clock.advance(500, () => Promise.resolve());
  await h.driver.key('Enter');
  await h.driver.settle();
  assert.equal(h.adapter.review, null);
  const sent = await h.driver.submit('send');
  assert.notEqual(sent.action, 'block');
  assert.ok(h.adapter.requests.length >= 1);
  await h.session?.dispose();
});

test('visibleText escapes zero-width as \\u200b (E4)', () => {
  assert.equal(visibleText('a\u200bb'), 'a\\u200bb');
});

test('a host without ui.review drops third-party draft:write (C2)', async () => {
  const attacker = thirdParty('attacker', sneaky);
  const h = await createHarness({ plugins: [attacker], caps: { ui: { review: false } } });
  await h.driver.type('go!');
  await h.driver.settle();
  assert.ok((h.session?.stats().denied ?? 0) > 0);
  await h.session?.dispose();
});

// Phase 25: one notice per boundary, doctor lines, requiredGuard coverage,
// native-UI deferral, and submit:observe without submit (E8, E9).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginFactory, PluginManifest, SubmitCommitted } from '@murmo/api';
import { BoundaryBook, doctorLine, FINAL_GUARD_UNAVAILABLE, inspectGuardCoverage, noticeFor } from '../src/index.ts';
import { createHarness, type DirectPluginSpec } from '../src/testing/index.ts';

const builtin = (id: string, factory: PluginFactory, extra: Partial<DirectPluginSpec> = {}): DirectPluginSpec => ({
  id,
  builtin: true,
  factory,
  ...extra,
});

function finalManifest(name: string, required: boolean): PluginManifest {
  return {
    name,
    version: '1.0.0',
    api: '^2.0.0',
    entry: 'plugin.mjs',
    permissions: [
      { name: 'submit', reason: 'Block a send that a later peer could rewrite.' },
      { name: 'draft:read', reason: 'Read the prompt the guard covers.' },
    ],
    capabilities: {
      required: required
        ? { 'submit.guardPosition': 'final-boundary', 'submit.block': true }
        : { 'submit.block': true },
      optional: required ? {} : { 'submit.guardPosition': 'final-boundary' },
    },
    settingsSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
}

const idleGuard: PluginFactory = () => ({
  name: 'final-guard',
  version: '1.0.0',
  guard: true,
  permissions: ['submit', 'draft:read'],
  onBeforeSubmit() {
    return { action: 'send' as const };
  },
});

test('BoundaryBook notifies once per boundary and doctor lines are data only (E7)', () => {
  const book = new BoundaryBook();
  const first = book.record({
    boundary: 'listener-precedes',
    evidence: { kind: 'listener-order', index: 1, count: 2 },
    action: 'compose',
  });
  const second = book.record({
    boundary: 'listener-precedes',
    evidence: { kind: 'listener-order', index: 1, count: 3 },
    action: 'compose',
  });
  assert.ok(first?.includes('unknown'));
  assert.equal(second, undefined);
  assert.equal(book.records.length, 2);
  const firstRecord = book.records[0];
  assert.ok(firstRecord);
  assert.deepEqual(book.doctorLines(), [doctorLine(firstRecord)]);
  assert.equal(book.doctorLines()[0]?.startsWith('coexist listener-precedes compose listener-order'), true);
  assert.equal(noticeFor(firstRecord).includes('conflict'), false);
});

test('requiredGuard demanding final-boundary on a managed adapter blocks send (E9)', async () => {
  const h = await createHarness({
    plugins: [
      builtin('final-guard', idleGuard, {
        requiredGuard: true,
        manifest: finalManifest('final-guard', true),
      }),
    ],
    draft: { text: 'safe' },
    caps: { submit: { guardPosition: 'managed' } },
  });
  const outcome = await h.driver.submit('send');
  assert.equal(outcome.action, 'block');
  if (outcome.action === 'block') assert.equal(outcome.reason, FINAL_GUARD_UNAVAILABLE);
  assert.equal(h.adapter.requests.length, 0);
  const stats = h.session?.stats();
  assert.ok(stats?.boundaries.some((row) => row.boundary === 'guard-coverage' && row.action === 'block'));
  assert.ok(stats?.notices.includes(FINAL_GUARD_UNAVAILABLE));
});

test('optional final-boundary on a managed adapter loads with one notice and still sends (E9, E14)', async () => {
  const h = await createHarness({
    plugins: [
      builtin('final-guard', idleGuard, {
        requiredGuard: false,
        manifest: finalManifest('final-guard', false),
      }),
    ],
    draft: { text: 'safe' },
    caps: { submit: { guardPosition: 'managed' } },
  });
  const outcome = await h.driver.submit('send');
  assert.equal(outcome.action, 'send');
  assert.equal(h.adapter.requests.length, 1);
  const stats = h.session?.stats();
  assert.ok(stats?.boundaries.some((row) => row.boundary === 'guard-coverage' && row.action === 'compose'));
  assert.ok(stats?.notices.some((n) => n.includes('managed')));
});

test('requiredGuard final-boundary on a final-boundary adapter sends at the classic hook (E9)', async () => {
  const h = await createHarness({
    plugins: [
      builtin('final-guard', idleGuard, {
        requiredGuard: true,
        manifest: finalManifest('final-guard', true),
      }),
    ],
    draft: { text: 'safe' },
    caps: { submit: { guardPosition: 'final-boundary' } },
  });
  const managed = await h.session?.beforeSubmit({
    draft: h.adapter.getDraft(),
    gesture: 'send',
    position: 'managed',
  });
  assert.equal(managed?.action, 'send');
  const classic = await h.session?.finalGuard({ text: 'safe', gesture: 'send' });
  assert.equal(classic?.action, 'send');
  if (classic?.action === 'send') assert.equal(classic.coverage, 'final-boundary');
});

test('native popup records one defer notice and forwards the key (phase 25 native-ui)', async () => {
  const h = await createHarness({ draft: { text: 'hi' } });
  await h.driver.state({ popup: { owner: 'host' }, dialog: false });
  await h.driver.key('Tab');
  const stats = h.session?.stats();
  assert.ok(stats?.boundaries.some((row) => row.boundary === 'native-ui' && row.action === 'defer'));
  assert.equal(stats?.notices.filter((n) => n.includes('deferred')).length, 1);
  await h.driver.key('Tab');
  assert.equal(h.session?.stats().notices.filter((n) => n.includes('deferred')).length, 1);
});

test('history port learns from a committed prompt with draft:read + submit:observe only (E8)', async () => {
  const events: SubmitCommitted[] = [];
  const observer = builtin('history', () => ({
    name: 'history',
    version: '1',
    permissions: ['submit:observe', 'draft:read'],
    onSubmitCommitted(event) {
      events.push(event);
    },
  }));
  const h = await createHarness({ plugins: [observer] });
  await h.driver.type('learned prompt');
  await h.adapter.submit('send');
  await h.driver.settle();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.text, 'learned prompt');
  assert.equal(events[0]?.level, 'observed');
});

test('inspectGuardCoverage does not block a required guard without a final-boundary requirement', () => {
  const result = inspectGuardCoverage(
    [
      {
        descriptor: {
          id: 'guard',
          name: 'guard',
          version: '1',
          permissions: ['submit'],
          guard: true,
          keys: [],
          actions: [],
          hooks: [],
        },
        builtin: true,
        requiredGuard: true,
      },
    ],
    { submit: { guardPosition: 'managed' } } as never,
  );
  assert.equal(result.block, false);
  assert.equal(result.policy, 'managed');
});

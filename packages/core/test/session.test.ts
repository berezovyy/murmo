// Session guarantees fixtures don't pin: honest health, composed highlights,
// a resync that drops typed coverage, and the key-path cost target.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS, type PluginFactory } from '@murmo/api';
import autocorrect from '@murmo/api/examples/autocorrect';
import snippets from '@murmo/api/examples/semicolon-menu';
import counter from '@murmo/api/examples/status-counter';
import todoGuard from '@murmo/api/examples/todo-guard';
import { DraftState } from '../src/index.ts';
import { canonicalKey, createHarness, type DirectPluginSpec } from '../src/testing/index.ts';

test('stats lists a disabled plugin and a dead executor while ready is true (E20, lessons 71, 76)', async () => {
  const thrower: DirectPluginSpec = {
    id: 'thrower',
    builtin: true,
    factory: () => ({
      name: 'thrower',
      version: '1',
      permissions: ['draft:read', 'draft:write'],
      onChange() {
        throw new Error('synthetic thrower');
      },
    }),
  };
  const h = await createHarness({ plugins: [thrower], health: 'down' });
  await h.driver.type('a');
  const stats = h.session?.stats();
  assert.equal(stats?.ready, true);
  assert.equal(stats?.disposed, false);
  assert.deepEqual(stats?.disabled, ['thrower']);
  assert.equal(stats?.plugins.find((p) => p.id === 'thrower')?.disabled, true);
  assert.equal(stats?.executor, 'down');
});

test("clearing one plugin's highlights keeps another's (E21, lesson 72)", async () => {
  let b: [number, number][] | null = [[1, 2]];
  const highlighter = (id: string, ranges: () => [number, number][] | null): DirectPluginSpec => ({
    id,
    builtin: true,
    factory: () => ({
      name: id,
      version: '1',
      permissions: ['draft:read'],
      onChange(change) {
        return [{ type: 'highlight', ranges: ranges(), baseVersion: change.draft.version }];
      },
    }),
  });
  const h = await createHarness({
    plugins: [highlighter('a', () => [[0, 1]]), highlighter('b', () => b)],
  });
  await h.driver.type('ab');
  assert.deepEqual(h.adapter.highlight, [
    [0, 1],
    [1, 2],
  ]);
  b = null;
  await h.driver.type('c');
  assert.deepEqual(h.adapter.highlight, [[0, 1]]);
});

test('onPause runs once, after LIMITS.pauseMs without a change, on the latest draft', async () => {
  // The typing pause belongs to the core: a plugin that waited inside onChange
  // spent its whole budget waiting (Pi phrases struck itself off).
  const paused: string[] = [];
  const pauser: DirectPluginSpec = {
    id: 'pauser',
    builtin: true,
    factory: () => ({
      name: 'pauser',
      version: '1',
      permissions: ['draft:read'],
      onPause(change, ctx) {
        paused.push(`${change.draft.text}|${ctx.draft.text}`);
        return [{ type: 'ghost', text: '!', baseVersion: ctx.draft.version }];
      },
    }),
  };
  const h = await createHarness({ plugins: [pauser] });
  await h.driver.type('a');
  await h.driver.wait(LIMITS.pauseMs - 1);
  await h.driver.type('b');
  await h.driver.wait(LIMITS.pauseMs - 1);
  assert.deepEqual(paused, [], 'typing within the pause restarts it');
  await h.driver.wait(1);
  await h.driver.settle();
  assert.deepEqual(paused, ['ab|ab']);
  assert.equal(h.adapter.ghost, '!');
  await h.driver.wait(LIMITS.pauseMs * 10);
  assert.deepEqual(paused, ['ab|ab'], 'one call per pause');
  await h.session?.dispose();
});

test('a ghost bound to an older baseVersion is never shown (E8)', async () => {
  const stale: DirectPluginSpec = {
    id: 'stale',
    builtin: true,
    factory: () => ({
      name: 'stale',
      version: '1',
      permissions: ['draft:read'],
      onChange(change) {
        return [{ type: 'ghost', text: 'nope', baseVersion: change.draft.version - 1 }];
      },
    }),
  };
  const h = await createHarness({ plugins: [stale] });
  await h.driver.type('ab');
  assert.equal(h.adapter.ghost, null);
});

test('a ledger that does not add up resyncs with no typed coverage (phase 04 hand-off)', () => {
  const intake = new DraftState(
    { text: 'ab', cursor: 2, version: 0, certainty: 'authoritative', typedSpans: [] },
    { evidence: 'host-labeled', keyBursts: true },
  );
  const [accepted] = intake.receive({
    draft: { text: 'xyz', cursor: 3, version: 1, certainty: 'authoritative', typedSpans: [[0, 3]] },
    origin: 'typed',
    before: { text: 'ab', cursor: 2, version: 0, certainty: 'authoritative', typedSpans: [] },
    deltas: [{ origin: 'typed', from: 0, to: 2, insert: 'nope' }],
  });
  assert.ok(accepted?.resynced);
  assert.equal(intake.resyncs, 1);
  assert.deepEqual(intake.draft.typedSpans, []);
  assert.equal(intake.draft.text, 'xyz');
  assert.equal(accepted.change.origin, 'unknown');
});

const four: DirectPluginSpec[] = [
  { id: 'autocorrect', builtin: true, factory: autocorrect },
  { id: 'snippets', builtin: true, factory: snippets },
  { id: 'todo-guard', builtin: true, factory: todoGuard },
  { id: 'counter', builtin: true, factory: counter },
];

function p99(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0;
}

test('added p99 per plain key with four plugins is ≤ 15 µs against a same-time control (E11, lesson 65)', async () => {
  const main = await createHarness({ plugins: four });
  const control = await createHarness({ control: true });
  const key = canonicalKey('a');
  const sample = (deliver: () => void): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const start = performance.now();
      deliver();
      out.push((performance.now() - start) * 1000);
    }
    return out;
  };
  // Warm the key path so the measured tail is the callback, not first-call ICs.
  for (let i = 0; i < 200; i++) {
    main.adapter.deliverKey(key);
    control.adapter.deliverKey(key);
  }
  const added = p99(sample(() => main.adapter.deliverKey(key))) - p99(sample(() => control.adapter.deliverKey(key)));
  assert.ok(added <= 15, `added p99 ${added.toFixed(2)} µs exceeds the 15 µs target`);
  await main.driver.settle();
});

test('unknown certainty never mutates; tracked needs the probed capability (phase 04 hand-off)', async () => {
  const edit: PluginFactory = () => ({
    name: 'edit',
    version: '1',
    permissions: ['draft:read', 'draft:write'],
    onChange(change) {
      return [{ type: 'edit', edit: { from: 0, to: 0, insert: 'x', baseVersion: change.draft.version } }];
    },
  });
  const unknown = await createHarness({
    plugins: [{ id: 'edit', builtin: true, factory: edit }],
    draft: { text: 'ab', certainty: 'unknown' },
  });
  await unknown.driver.type('z');
  assert.equal(unknown.adapter.getDraft().text, 'abz');
  assert.equal(unknown.session?.stats().applied, 0);

  const tracked = await createHarness({
    plugins: [{ id: 'edit', builtin: true, factory: edit }],
    draft: { text: 'ab', certainty: 'tracked' },
    caps: { edit: { certainties: ['authoritative'] } },
  });
  await tracked.driver.type('z');
  assert.equal(tracked.adapter.getDraft().text, 'abz');
  assert.equal(tracked.session?.stats().commits.unsupported, 1);
});

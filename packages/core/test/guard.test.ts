// Fail-open (E10, lessons 15, 23): a throw in a session callback must not reach
// the adapter, and the third error turns the session off with one notice.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginFactory } from '@murmo/api';
import { FAILURE_LIMIT, FailOpen, KILL_NOTICE } from '../src/index.ts';
import { createHarness, type DirectPluginSpec } from '../src/testing/index.ts';

test('wrap returns the safe answer and never throws (E10: a Murmo bug must not eat a key)', () => {
  const seen: unknown[] = [];
  const guard = new FailOpen((error) => seen.push(error));
  const wrapped = guard.wrap((n: number) => {
    if (n < 0) throw new Error('boom');
    return n * 2;
  }, -1);
  assert.equal(wrapped(3), 6);
  assert.equal(wrapped(-2), -1);
  assert.equal(guard.failures, 1);
  assert.equal(guard.tripped, false);
  assert.equal(seen.length, 0);
});

test('the third failure trips once; later failures do not notify again (E10, lesson 23)', () => {
  const trips: unknown[] = [];
  const guard = new FailOpen((error) => trips.push(error), FAILURE_LIMIT);
  const wrapped = guard.wrap(() => {
    throw new Error('x');
  }, 'pass');
  assert.equal(wrapped(), 'pass');
  assert.equal(wrapped(), 'pass');
  assert.equal(guard.tripped, false);
  assert.equal(wrapped(), 'pass');
  assert.equal(guard.tripped, true);
  assert.equal(trips.length, 1);
  assert.equal(wrapped(), 'pass');
  assert.equal(trips.length, 1);
  assert.equal(guard.failures, 4);
});

const boom: PluginFactory = () => ({
  name: 'boom',
  version: '1',
  permissions: ['draft:read', 'draft:write'],
  onChange(change) {
    if (change.origin !== 'typed') return [];
    return [{ type: 'edit', edit: { from: 0, to: 0, insert: 'x', baseVersion: change.draft.version } }];
  },
});

test('a throw inside a session task never reaches the adapter; the third kills with one notice (E10)', async () => {
  const notices: string[] = [];
  const plugin: DirectPluginSpec = { id: 'boom', builtin: true, factory: boom };
  const h = await createHarness({
    plugins: [plugin],
    notify: (message) => notices.push(message),
    gates: [
      {
        name: 'boom',
        check() {
          throw new Error('core bug');
        },
      },
    ],
  });
  for (const key of ['a', 'b', 'c']) {
    assert.equal(await h.driver.key(key), 'pass');
    await h.driver.settle();
  }
  const stats = h.session?.stats();
  assert.equal(stats?.killed, true);
  assert.equal(stats?.failures, 3);
  assert.equal(stats?.disposed, true);
  assert.deepEqual(notices, [KILL_NOTICE]);
  assert.equal(stats?.notices.filter((n) => n === KILL_NOTICE).length, 1);
  assert.equal(h.adapter.getDraft().text, 'abc');
  assert.equal(await h.driver.key('d'), 'pass');
});

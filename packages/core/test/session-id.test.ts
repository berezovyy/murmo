// ctx.session.id is stable across plugin reload and unique per session (E28).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from '../src/testing/index.ts';

test('a plugin reloaded mid-session sees the same ctx.session.id (E28)', async () => {
  const seen: string[] = [];
  const h = await createHarness({
    sessionId: 'sess-1',
    plugins: [
      {
        id: 'meter',
        builtin: false,
        factory: () => ({
          name: 'meter',
          version: '1',
          permissions: ['draft:read'],
          activate(ctx) {
            seen.push(ctx.session.id);
          },
        }),
      },
    ],
  });
  await h.session?.ready;
  await h.driver.settle();
  await h.session?.applyPlugin({ action: 'disable', id: 'meter' });
  await h.session?.applyPlugin({ action: 'enable', id: 'meter' });
  await h.driver.settle();
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((id) => id === 'sess-1'));
  assert.equal(h.session?.sessionId, 'sess-1');
  await h.session?.dispose();
});

test('a new session gets a different id (E28)', async () => {
  const a = await createHarness({ sessionId: 'a' });
  const b = await createHarness({ sessionId: 'b' });
  assert.notEqual(a.session?.sessionId, b.session?.sessionId);
  await a.session?.dispose();
  await b.session?.dispose();
});

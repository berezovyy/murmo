// A SIGKILLed supervisor must not look healthy; a required guard blocks send (E20, E22).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TRANSPORT_UNAVAILABLE } from '../src/index.ts';
import { createHarness } from '../src/testing/index.ts';

test('a down executor shows as unavailable and blocks a guard send (E22)', async () => {
  const h = await createHarness({
    health: 'down',
    plugins: [
      {
        id: 'guard',
        builtin: true,
        factory: () => ({
          name: 'guard',
          version: '1',
          guard: true,
          permissions: ['submit', 'draft:read:full'],
          onBeforeSubmit() {
            return { action: 'send' as const };
          },
        }),
      },
    ],
  });
  await h.session?.ready;
  assert.equal(h.session?.stats().executor, 'down');
  const outcome = await h.driver.submit('send');
  assert.equal(outcome.action, 'block');
  if (outcome.action === 'block') assert.equal(outcome.reason, TRANSPORT_UNAVAILABLE);
  await h.session?.dispose();
});

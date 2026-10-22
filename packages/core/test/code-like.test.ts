// at-code-like-word: Tab is consumed only at the end of a code-like token, and
// native popups still win (docs/plan/36).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atCodeLikeWord, isCodeLike, wordAtCursor } from '../src/index.ts';
import { createHarness } from '../src/testing/index.ts';

test('code-like tokens match; prose and mid-word do not', () => {
  assert.equal(isCodeLike('OutboxWorkr'), true);
  assert.equal(isCodeLike('outbox_worker'), true);
  assert.equal(isCodeLike('the'), false);
  assert.equal(atCodeLikeWord('OutboxWorkr', 11), true);
  assert.equal(atCodeLikeWord('OutboxWorkr x', 11), true);
  assert.equal(atCodeLikeWord('OutboxWorkr', 5), false, 'mid-word');
  assert.equal(atCodeLikeWord('the', 3), false);
  assert.equal(wordAtCursor('  FooBar', 8).word, 'FooBar');
});

test('a names-style claim consumes Tab only on a code-like word', async () => {
  const h = await createHarness({
    plugins: [
      {
        id: 'names',
        builtin: true,
        factory: () => ({
          name: 'names',
          version: '1',
          permissions: [],
          keys: [{ key: 'Tab', when: ['editable', 'at-code-like-word'], action: 'dispatch', consume: true }],
        }),
      },
    ],
  });
  await h.driver.type('hello');
  assert.equal(await h.driver.key('Tab'), 'pass', 'prose Tab passes through');
  await h.driver.type(' OutboxWorkr');
  assert.equal(await h.driver.key('Tab'), 'consume');
  await h.driver.state({ popup: { owner: 'host' } });
  assert.equal(await h.driver.key('Tab'), 'pass', 'native popup still wins');
  await h.session?.dispose();
});

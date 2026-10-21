// Two Backspace rejections in different drafts add the word; private mode
// adds nothing; murmo words remove deletes it (vision principle 6).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHarness } from '@murmo/core/testing';
import { autocorrectSpec } from '@murmo/plugin-autocorrect';
import { loadEnglishPack } from '@murmo/plugin-autocorrect/node';
import { openStore } from '@murmo/store/node';
import { createLearner, learnedStatus } from '../src/node/learn.ts';
import { wordsCommand } from '../src/node/words.ts';
import { tempStore } from './helpers.ts';

before(() => {
  loadEnglishPack();
});

test('two Backspace rejections in different drafts add the word; private mode does not', async () => {
  const t = tempStore('murmo-vocab-learn-');
  after(() => t.remove());
  const store = await openStore({ roots: t.roots });
  const rejected: string[] = [];
  const learner = createLearner(store, () => 1_700_000_000_000);
  const h = await createHarness({
    plugins: [autocorrectSpec('autocorrect', { enabled: true })],
    onRejectedWord: (word) => {
      rejected.push(word);
    },
  });
  await h.driver.type('teh ');
  assert.equal(h.adapter.getDraft().text, 'the ');
  await h.driver.key('Backspace');
  await h.driver.settle();
  assert.equal(rejected.length, 1);
  const first = await learner.note(rejected[0] as string);
  assert.equal(first.allow, null);
  assert.deepEqual(await store.words.list(), []);
  await h.driver.submit('send');
  learner.endDraft();
  await h.driver.type('teh ');
  await h.driver.key('Backspace');
  await h.driver.settle();
  assert.equal(rejected.length, 2);
  const second = await learner.note(rejected[1] as string);
  assert.equal(second.allow, 'teh');
  assert.equal(second.status, learnedStatus('teh'));
  assert.deepEqual(await store.words.list(), ['teh']);
  await h.session?.dispose();

  const priv = await openStore({ roots: t.roots, configPrivate: true });
  const blocked = createLearner(priv);
  const result = await blocked.note('adn');
  assert.equal(result.allow, null);

  const out: string[] = [];
  const err: string[] = [];
  assert.equal(
    await wordsCommand(['remove', 'teh'], { store, cwd: t.dir, out: (s) => out.push(s), err: (s) => err.push(s) }),
    0,
  );
  assert.deepEqual(await store.words.list(), []);
});

// Gates: size, private, expiry, foreign project, unknown certainty
// (vision principle 6, lesson 34).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHarness, testInlinePlugin } from '@murmo/core/testing';
import { DRAFT_MAX_TEXT_BYTES, DRAFT_TTL_MS } from '@murmo/store';
import { rescuePlugin } from '../src/index.ts';
import {
  assertNoOffer,
  identity,
  idleSave,
  MANUAL_EPOCH_MS,
  presentOffer,
  tempStore,
  UNICODE,
  withRescue,
} from './helpers.ts';

const cleanup: { remove: () => void }[] = [];
after(() => {
  for (const t of cleanup) t.remove();
});
const fresh = () => {
  const t = tempStore();
  cleanup.push(t);
  return t;
};

test('a draft over 64 KiB is not saved, the previous snapshot is removed, and one status note is shown', async () => {
  const t = fresh();
  const store = await t.store;
  const id = identity('big');
  const h = await withRescue(store, 'big');
  await h.driver.fill('small', 'typed');
  await idleSave(h, store, id);
  await h.driver.fill('x'.repeat(DRAFT_MAX_TEXT_BYTES + 1), 'typed');
  await h.driver.settle();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await store.drafts.read(id), undefined);
  assert.match(h.adapter.status ?? '', /over 64 KiB/);
  await h.session?.dispose();
});

test('private mode saves nothing and removes this session snapshot', async () => {
  const t = fresh();
  const store = await t.store;
  const id = identity('priv');
  const h = await withRescue(store, 'priv');
  await h.driver.fill('secret diary', 'typed');
  await idleSave(h, store, id);
  store.privacy.setConfigPrivate(true);
  await h.driver.fill('secret diary!', 'typed');
  await h.driver.wait(500);
  await h.driver.settle();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await store.drafts.read(id), undefined);
  await h.session?.dispose();
});

test('25-hour-old and foreign-project snapshots give no offer and are cleaned at start', async () => {
  const t = fresh();
  const store = await t.store;
  const stale = identity('stale');
  await store.drafts.save(stale, {
    text: UNICODE,
    cursorUTF16: 0,
    revision: 1,
    now: MANUAL_EPOCH_MS - DRAFT_TTL_MS - 60_000,
  });
  const foreign: typeof stale = { project: 'ab'.repeat(32), host: 'fake', session: 'other' };
  await store.drafts.save(foreign, { text: UNICODE, cursorUTF16: 0, revision: 1, now: MANUAL_EPOCH_MS });
  const h = await withRescue(store, 'fresh');
  await assertNoOffer(h);
  assert.equal(await store.drafts.read(stale), undefined, 'expired file is removed at start');
  assert.equal((await store.drafts.read(foreign))?.text, UNICODE, 'another project is left alone');
  await h.session?.dispose();
});

test('unknown certainty is not saved (Codex shadow draft)', async () => {
  const t = fresh();
  const store = await t.store;
  const id = identity('unk');
  const h = await createHarness({
    runner: 'direct',
    plugins: [rescuePlugin({ drafts: store.drafts, identity: id, isPrivate: () => false })],
    draft: { text: 'shadow', certainty: 'unknown' },
  });
  await h.driver.wait(500);
  await h.driver.settle();
  assert.equal(await store.drafts.read(id), undefined);
  await h.session?.dispose();
});

test('restored text is not typed: a typed boundary after restore does not correct it (principle 7)', async () => {
  const t = fresh();
  const store = await t.store;
  await store.drafts.save(identity('typo'), { text: 'teh', cursorUTF16: 3, revision: 1, now: MANUAL_EPOCH_MS });
  const inline = testInlinePlugin('english');
  const h = await createHarness({
    runner: 'direct',
    plugins: [
      { ...inline, builtin: true },
      rescuePlugin({ drafts: store.drafts, identity: identity('now'), isPrivate: () => false }),
    ],
  });
  await presentOffer(h);
  await h.driver.key('Tab');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 'teh');
  await h.driver.type(' ');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 'teh ', 'teh is plugin-origin, so Space does not correct it');
  await h.session?.dispose();
});

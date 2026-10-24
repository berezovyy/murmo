// Lifecycle matrix on the fake host (docs/plan/17): abrupt end, submit levels,
// empty Ctrl+C, offer/restore, sessions don't cross.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { type CapsPatch, createHarness, ReferenceAdapter } from '@murmo/core/testing';
import { draftIsOfferable } from '@murmo/store';
import type { Store } from '@murmo/store/node';
import { IDLE_MS, offerGhost, offerLine, rescuePlugin } from '../src/index.ts';
import {
  assertNoOffer,
  EMPTY_DELETE_MS,
  HOST_CAPS,
  identity,
  idleSave,
  MANUAL_EPOCH_MS,
  presentOffer,
  tempStore,
  UNICODE,
  waitGone,
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

test('a unicode draft is saved after 500 ms idle and not before (typing never waits)', async () => {
  const t = fresh();
  const store = await t.store;
  const id = identity('s1');
  const h = await withRescue(store, 's1');
  await h.driver.fill(UNICODE, 'typed');
  await h.driver.settle();
  assert.equal(await store.drafts.read(id), undefined, 'no write on the key path');
  const doc = await idleSave(h, store, id);
  assert.equal(doc.text, UNICODE);
  assert.equal(doc.header.cursorUTF16, UNICODE.length);
  await h.session?.dispose();
});

test('restore is byte-exact after a dead session; Tab inserts plugin-origin text; Backspace undoes (lesson 33, principle 7)', async () => {
  const t = fresh();
  const store = await t.store;
  const old = identity('dead');
  await store.drafts.save(old, { text: UNICODE, cursorUTF16: UNICODE.length, revision: 3, now: MANUAL_EPOCH_MS });
  for (const [host, caps] of Object.entries(HOST_CAPS)) {
    const h = await withRescue(store, `live-${host}`, { caps });
    await presentOffer(h);
    assert.match(h.adapter.status ?? '', /Restore your last draft from \d{2}:\d{2}\? \(Tab\)/, host);
    assert.ok(h.adapter.ghost, host);
    const routing = await h.driver.key('Tab');
    await h.driver.settle();
    assert.equal(routing, 'consume', host);
    assert.equal(h.adapter.getDraft().text, UNICODE, host);
    assert.equal(h.adapter.getDraft().typedSpans.length, 0, `${host}: restored text is not typed`);
    assert.equal(h.adapter.edits[0]?.edit.label, 'restore', host);
    await h.driver.key('Backspace');
    await h.driver.settle();
    assert.equal(h.adapter.getDraft().text, '', `${host}: Backspace undoes restore`);
    await h.session?.dispose();
  }
});

test('typing hides the offer without ending it; an empty prompt shows it again; only Escape dismisses it', async () => {
  // Pi (r3pic-2, r5e11g-2): any key threw the offer away for the session.
  const t = fresh();
  const store = await t.store;
  const old = identity('kept');
  await store.drafts.save(old, { text: UNICODE, cursorUTF16: UNICODE.length, revision: 1, now: MANUAL_EPOCH_MS });
  const h = await withRescue(store, 's2');
  await presentOffer(h);
  await h.driver.type('x');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 'x', 'the offer never replaces a non-empty composer');
  assert.equal(h.adapter.ghost, null);
  assert.equal(h.adapter.status, null);
  assert.equal(await store.drafts.read(old).then((d) => d?.text), UNICODE);
  await h.driver.key('Backspace');
  await h.driver.settle();
  await presentOffer(h);
  assert.equal(await h.driver.key('Escape'), 'consume');
  await h.driver.settle();
  assert.equal(h.adapter.status, null);
  assert.equal(h.adapter.ghost, null);
  await h.driver.type('y');
  await h.driver.key('Backspace');
  await h.driver.settle();
  assert.equal(h.adapter.status, null, 'dismissed for the rest of the session');
  await h.session?.dispose();
});

test('the offer reads as an offer: one line, not the draft itself as ghost text', async () => {
  // Pi (R2E1C-8): the whole draft as ghost looked restored, and its line breaks showed as \u000a.
  const t = fresh();
  const store = await t.store;
  const text = 'fix the login bug\nthen run the tests\n\nand commit';
  await store.drafts.save(identity('multi'), { text, cursorUTF16: 0, revision: 1, now: MANUAL_EPOCH_MS });
  const h = await withRescue(store, 'reader');
  await presentOffer(h);
  assert.equal(h.adapter.ghost, 'Tab restores: fix the login bug… (+2 lines)');
  assert.equal(offerGhost('x'.repeat(50)), `Tab restores: ${'x'.repeat(40)}…`);
  await h.driver.key('Tab');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, text);
  await h.session?.dispose();
});

test('a stray key typed and deleted is not saved over an older crash draft (r3pic-6)', async () => {
  const t = fresh();
  const store = await t.store;
  const crashed = identity('crashed');
  await store.drafts.save(crashed, { text: UNICODE, cursorUTF16: 0, revision: 1, now: MANUAL_EPOCH_MS });
  const h = await withRescue(store, 'stray');
  await h.driver.type('Z');
  await h.driver.wait(IDLE_MS * 2);
  await h.driver.settle();
  await new Promise((r) => setTimeout(r, 50)); // let a save, if one was queued, reach the disk
  await h.driver.key('Backspace');
  await h.driver.settle();
  await h.session?.dispose();
  assert.equal(await store.drafts.read(identity('stray')), undefined, 'one character is not worth a save');
  const next = await withRescue(store, 'after-clean-quit');
  assert.match(await presentOffer(next), /Restore your last draft/);
  await next.driver.key('Tab');
  await next.driver.settle();
  assert.equal(next.adapter.getDraft().text, UNICODE, 'the older crash draft is still the one offered');
  await next.session?.dispose();
});

test('a draft holding a folded paste is never saved, and the last whole draft stays the one offered', async () => {
  // OpenCode folds a big paste into `[Pasted ~1 lines]`: rescue saved the
  // label and, after a crash, offered to type it back instead of the paste.
  const t = fresh();
  const store = await t.store;
  const id = identity('folded');
  const h = await withRescue(store, 'folded');
  await h.driver.type('review this log: ');
  await idleSave(h, store, id);
  await h.driver.pasteFolded('[Pasted ~1 lines]');
  await h.driver.type(' thanks');
  await h.driver.wait(IDLE_MS * 2);
  await h.driver.settle();
  await new Promise((r) => setTimeout(r, 50)); // let a save, if one was queued, reach the disk
  assert.equal((await store.drafts.read(id))?.text, 'review this log: ', 'the whole draft before the paste stays');
  await h.driver.wait(EMPTY_DELETE_MS * 2);
  await h.driver.settle();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await store.drafts.read(id))?.text, 'review this log: ', 'a folded draft is not an empty one');

  const other = identity('folded-only');
  const only = await withRescue(store, 'folded-only');
  await only.driver.pasteFolded('[Pasted ~40 lines]');
  await only.driver.wait(IDLE_MS * 2);
  await only.driver.settle();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await store.drafts.read(other), undefined, 'the label alone is never saved');
  await only.session?.dispose();
  await h.session?.dispose();
});

test('no offer where Tab never reaches plugins (Claude routes Tab natively); the draft is still kept', async () => {
  // An offer that says "(Tab)" where Tab can't restore would be a lie.
  const t = fresh();
  const store = await t.store;
  const crashed = identity('claude-dead');
  await store.drafts.save(crashed, { text: UNICODE, cursorUTF16: 0, revision: 1, now: MANUAL_EPOCH_MS });
  const h = await withRescue(store, 'no-tab', { caps: { keys: ['space', 'Backspace', 'Escape'] } });
  await assertNoOffer(h);
  assert.equal(h.adapter.ghost, null);
  assert.equal((await store.drafts.read(crashed))?.text, UNICODE);
  await h.session?.dispose();
});

test("where Tab never reaches plugins, the host's own empty-prompt suggestion carries the draft", async () => {
  // Claude: no Tab for plugins, so the offer never showed after a crash. Its
  // `$.prompt.suggest` shows the draft dim in the empty box and its Tab takes it.
  const t = fresh();
  const store = await t.store;
  const crashed = identity('claude-crashed');
  await store.drafts.save(crashed, { text: UNICODE, cursorUTF16: 0, revision: 1, now: MANUAL_EPOCH_MS });
  const suggested: string[] = [];
  const h = await withRescue(store, 'claude-live', {
    caps: { keys: ['space', 'Backspace', 'Escape'] },
    suggest: (text) => suggested.push(text),
  });
  await presentOffer(h);
  await h.driver.wait(1); // after the hook returns, so the host sees the box empty
  assert.equal(h.adapter.ghost, null, 'no ghost of its own: the host draws the suggestion');
  assert.deepEqual(suggested, [UNICODE], 'the draft itself, byte-exact, is what Tab takes');

  // Typing hides the offer (the host drops its suggestion); an empty prompt asks again.
  await h.driver.type('x');
  await h.driver.settle();
  assert.equal(h.adapter.status, null);
  await h.driver.key('Backspace');
  await presentOffer(h);
  await h.driver.wait(1);
  assert.equal(suggested.length, 2);

  // The host's Tab puts the suggestion in the box: the offer is over, and nothing is typed.
  await h.driver.fill(UNICODE, 'native-menu');
  await h.driver.settle();
  assert.equal(h.adapter.status, null);
  assert.equal(h.adapter.getDraft().typedSpans.length, 0, 'restored text is never corrected or expanded');
  await h.driver.fill('', 'unknown');
  await h.driver.settle();
  assert.equal(h.adapter.status, null, 'restored once, never offered again');
  assert.equal(suggested.length, 2);
  await h.session?.dispose();
});

test("a send ends a host-suggestion offer: the host's own suggestions may hold Tab after a turn", async () => {
  // Claude suggests a next prompt after each turn; a lingering "(Tab)" offer would name its Tab.
  const t = fresh();
  const store = await t.store;
  await store.drafts.save(identity('claude-old'), {
    text: 'old draft',
    cursorUTF16: 0,
    revision: 1,
    now: MANUAL_EPOCH_MS,
  });
  const suggested: string[] = [];
  const h = await withRescue(store, 'claude-send', {
    caps: { keys: ['space', 'Backspace', 'Escape'] },
    suggest: (text) => suggested.push(text),
  });
  await presentOffer(h);
  await h.driver.wait(1);
  await h.driver.fill('something else', 'typed');
  await h.driver.submit('send');
  await h.driver.settle();
  await h.driver.wait(1);
  await assertNoOffer(h);
  assert.deepEqual(suggested, ['old draft']);
  await h.session?.dispose();
});

test('submit observed and inferred remove the snapshot; unknown marks attempted and is not offered; a block keeps it', async () => {
  const t = fresh();
  const store = await t.store;

  const observedId = identity('obs');
  const observed = await withRescue(store, 'obs');
  await observed.driver.fill('keep me', 'typed');
  await idleSave(observed, store, observedId);
  await observed.driver.submit('send');
  await observed.driver.settle();
  await waitGone(store, observedId);
  await observed.session?.dispose();

  const inferredId = identity('inf');
  const inferred = await harness(store, 'inf', { caps: { submit: { committed: 'none' } } });
  await inferred.driver.fill('inferred text', 'typed');
  await idleSave(inferred, store, inferredId);
  await inferred.driver.submit('send');
  await inferred.driver.settle();
  await waitGone(store, inferredId);
  await inferred.session?.dispose();

  const unknownId = identity('unk');
  const unknown = await harness(store, 'unk');
  await unknown.driver.fill('maybe sent', 'typed');
  await idleSave(unknown, store, unknownId);
  await store.drafts.markAttempted(unknownId, MANUAL_EPOCH_MS);
  const marked = await store.drafts.read(unknownId);
  assert.equal(marked?.header.attempted, true);
  assert.equal(draftIsOfferable(marked as NonNullable<typeof marked>, MANUAL_EPOCH_MS), false);
  await unknown.session?.dispose();
  const next = await withRescue(store, 'unk-next');
  await assertNoOffer(next);
  await next.session?.dispose();

  const blockedId = identity('blk');
  const blocked = await createHarness({
    runner: 'direct',
    plugins: [
      rescuePlugin({
        drafts: store.drafts,
        identity: blockedId,
        isPrivate: () => store.privacy.isPrivate(),
      }),
      {
        id: 'block',
        builtin: true,
        factory: () => ({
          name: 'block',
          version: '1',
          permissions: ['submit', 'draft:read'],
          onBeforeSubmit: () => ({ action: 'block' as const, reason: 'nope' }),
        }),
      },
    ],
  });
  await blocked.driver.fill('blocked text', 'typed');
  await idleSave(blocked, store, blockedId);
  await blocked.driver.submit('send');
  await blocked.driver.settle();
  assert.equal((await store.drafts.read(blockedId))?.text, 'blocked text');
  await blocked.session?.dispose();
  const afterBlock = await withRescue(store, 'blk-next');
  await presentOffer(afterBlock);
  await afterBlock.session?.dispose();
});

test('an empty draft does not delete (Ctrl+C); 10 s of empty while alive does (r9 Codex)', async () => {
  const t = fresh();
  const store = await t.store;
  const id = identity('empty');
  const h = await withRescue(store, 'empty');
  await h.driver.fill('doomed', 'typed');
  await idleSave(h, store, id);
  h.adapter.fill('', 'unknown');
  await h.driver.settle();
  assert.equal((await store.drafts.read(id))?.text, 'doomed', 'empty does not delete at once');
  await h.session?.dispose();
  const offered = await withRescue(store, 'empty-next');
  await presentOffer(offered);
  await offered.session?.dispose();

  const live = await withRescue(store, 'empty');
  await live.driver.fill('cleared on purpose', 'typed');
  await idleSave(live, store, id);
  live.adapter.fill('', 'unknown');
  await live.driver.settle();
  await live.driver.wait(EMPTY_DELETE_MS);
  await live.driver.settle();
  await waitGone(store, id);
  await live.session?.dispose();
});

test('two live sessions in one project are never offered each other (liveness lock)', async () => {
  const t = fresh();
  const store = await t.store;
  const a = await withRescue(store, 'live-a');
  await a.driver.fill('session A draft', 'typed');
  await idleSave(a, store, identity('live-a'));
  const b = await withRescue(store, 'live-b');
  await assertNoOffer(b);
  assert.equal(b.adapter.getDraft().text, '');
  await a.session?.dispose();
  await b.session?.dispose();
  const c = await withRescue(store, 'live-c');
  await presentOffer(c);
  await c.session?.dispose();
});

test('a session whose activate was cancelled at startup still holds its lock (OpenCode attaches the prompt late)', async () => {
  // OpenCode starts the session before its prompt editor exists, so the host
  // reads as a dialog and every activate is cancelled as stale. The lock was
  // taken only in activate, so a second window offered this live draft.
  const t = fresh();
  const store = await t.store;
  const adapter = new ReferenceAdapter();
  adapter.setState({ dialog: true });
  const id = identity('late-prompt');
  const a = await createHarness({
    runner: 'direct',
    adapter,
    plugins: [rescuePlugin({ drafts: store.drafts, identity: id, isPrivate: () => false })],
  });
  await a.driver.state({ dialog: false });
  await a.driver.fill('typed after the prompt attached', 'typed');
  await idleSave(a, store, id);
  const b = await withRescue(store, 'second-window');
  await assertNoOffer(b);
  await a.session?.dispose();
  await b.session?.dispose();
});

test('cross-host snapshots are not offered', async () => {
  const t = fresh();
  const store = await t.store;
  await store.drafts.save(identity('pi-dead', 'pi'), {
    text: UNICODE,
    cursorUTF16: 0,
    revision: 1,
    now: MANUAL_EPOCH_MS,
  });
  const h = await withRescue(store, 'fake-live', { host: 'fake' });
  await assertNoOffer(h);
  await h.session?.dispose();
});

test('offerLine is the architecture one-liner with a clock time', () => {
  assert.match(offerLine(0), /^Restore your last draft from \d{2}:\d{2}\? \(Tab\)$/);
});

function harness(
  store: Store,
  session: string,
  extra: { caps?: CapsPatch; holdSubmit?: boolean; commitWindowMs?: number } = {},
) {
  return createHarness({
    runner: 'direct',
    plugins: [
      rescuePlugin({
        drafts: store.drafts,
        identity: identity(session),
        isPrivate: () => store.privacy.isPrivate(),
      }),
    ],
    ...(extra.caps ? { caps: extra.caps } : {}),
    ...(extra.holdSubmit ? { holdSubmit: true } : {}),
    ...(extra.commitWindowMs === undefined ? {} : { commitWindowMs: extra.commitWindowMs }),
  });
}

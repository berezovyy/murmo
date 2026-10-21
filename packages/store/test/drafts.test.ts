// Draft format, file modes, liveness, expiry, size/private gates
// (docs/plan/17, DRAFT-FORMAT v1, vision principle 6).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  DRAFT_MAX_TEXT_BYTES,
  DRAFT_TTL_MS,
  decodeDraft,
  draftFile,
  draftHeader,
  draftIsOfferable,
  encodeDraft,
} from '../src/index.ts';
import { openStore } from '../src/node/index.ts';
import { type TempRoots, tempRoots } from './helpers.ts';

const cleanup: TempRoots[] = [];
after(() => {
  for (const t of cleanup) t.remove();
});
const fresh = () => {
  const t = tempRoots('murmo-drafts-');
  cleanup.push(t);
  return t;
};
const project = (name: string) => createHash('sha256').update(name).digest('hex');
const A = project('a');
const UNICODE = '👨‍👩‍👧‍👦\n🇺🇸\ne\u0301\n你好\n\n';

test('encode/decode is byte-exact for a ZWJ family, flag, decomposed accent, CJK and newlines', () => {
  const id = { project: A, host: 'fake' as const, session: 's1' };
  const header = draftHeader(id, {
    revision: 7,
    cursorUTF16: UNICODE.length,
    capturedAt: 1_792_414_800_000,
    textBytes: new TextEncoder().encode(UNICODE).length,
  });
  const bytes = encodeDraft(header, UNICODE);
  const decoded = decodeDraft(bytes);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.document.text, UNICODE);
  assert.equal(decoded.document.header.cursorUTF16, UNICODE.length);
  assert.equal(decoded.document.header.session, 's1');
});

test('a cursor inside a surrogate pair is refused (phase 04: never round)', () => {
  const id = { project: A, host: 'pi' as const, session: 's1' };
  const text = '😀'; // two UTF-16 units
  assert.throws(() =>
    encodeDraft(
      draftHeader(id, { revision: 0, cursorUTF16: 1, capturedAt: 1, textBytes: new TextEncoder().encode(text).length }),
      text,
    ),
  );
});

test('files are 0600, directories 0700, and a widened mode is repaired on read', async () => {
  const t = fresh();
  const store = await openStore({ roots: t.roots });
  const id = { project: A, host: 'fake' as const, session: 's1' };
  const saved = await store.drafts.save(id, { text: UNICODE, cursorUTF16: UNICODE.length, revision: 1 });
  assert.equal(saved.status, 'ok');
  const path = draftFile(store.layout, A, 'fake', 's1');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700);
  chmodSync(path, 0o644);
  const read = await store.drafts.read(id);
  assert.equal(read?.text, UNICODE);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('oversize and private writes are denied and remove the previous snapshot', async () => {
  const t = fresh();
  const store = await openStore({ roots: t.roots });
  const id = { project: A, host: 'fake' as const, session: 's1' };
  assert.equal((await store.drafts.save(id, { text: 'ok', cursorUTF16: 2, revision: 3 })).status, 'ok');
  const big = 'x'.repeat(DRAFT_MAX_TEXT_BYTES + 1);
  assert.equal((await store.drafts.save(id, { text: big, cursorUTF16: 0, revision: 4 })).status, 'denied');
  assert.equal(await store.drafts.read(id), undefined);

  assert.equal((await store.drafts.save(id, { text: 'ok', cursorUTF16: 2, revision: 5 })).status, 'ok');
  store.privacy.setConfigPrivate(true);
  assert.equal((await store.drafts.save(id, { text: 'ok', cursorUTF16: 2, revision: 6 })).status, 'denied');
  assert.equal(await store.drafts.read(id), undefined);
});

test('a live session lock is not offerable; a missing or dead lock is', async () => {
  const t = fresh();
  const store = await openStore({ roots: t.roots });
  const live = { project: A, host: 'fake' as const, session: 'live' };
  const dead = { project: A, host: 'fake' as const, session: 'dead' };
  const lock = await store.drafts.holdLock(live);
  await store.drafts.save(live, { text: 'from live', cursorUTF16: 9, revision: 1 });
  await store.drafts.save(dead, { text: 'from dead', cursorUTF16: 9, revision: 1 });
  const fromOther = await store.drafts.findOfferable({ project: A, host: 'fake', session: 'viewer' });
  assert.equal(fromOther?.text, 'from dead');
  assert.equal(draftIsOfferable(fromOther, Date.now()), true);
  await lock.release();
  const after = await store.drafts.findOfferable({ project: A, host: 'fake', session: 'viewer' });
  assert.ok(after);
});

test('expired and attempted snapshots are not offerable; cleanup removes expired files', async () => {
  const t = fresh();
  const store = await openStore({ roots: t.roots });
  const old = { project: A, host: 'fake' as const, session: 'old' };
  await store.drafts.save(old, {
    text: 'expired',
    cursorUTF16: 0,
    revision: 1,
    now: Date.now() - DRAFT_TTL_MS - 1000,
  });
  assert.equal(await store.drafts.findOfferable({ project: A, host: 'fake', now: Date.now() }), undefined);
  await store.drafts.cleanup(Date.now());
  assert.equal(existsSync(draftFile(store.layout, A, 'fake', 'old')), false);

  const sent = { project: A, host: 'fake' as const, session: 'sent' };
  await store.drafts.save(sent, { text: 'probably sent', cursorUTF16: 0, revision: 1 });
  await store.drafts.markAttempted(sent);
  const marked = await store.drafts.read(sent);
  assert.equal(marked?.header.attempted, true);
  assert.equal(await store.drafts.findOfferable({ project: A, host: 'fake' }), undefined);
});

test('saving replaces dead sessions for the same project and host only', async () => {
  const t = fresh();
  const store = await openStore({ roots: t.roots });
  const dead = { project: A, host: 'fake' as const, session: 'dead' };
  const otherHost = { project: A, host: 'pi' as const, session: 'dead-pi' };
  await store.drafts.save(dead, { text: 'old', cursorUTF16: 0, revision: 1 });
  await store.drafts.save(otherHost, { text: 'pi old', cursorUTF16: 0, revision: 1 });
  const live = { project: A, host: 'fake' as const, session: 'now' };
  await store.drafts.holdLock(live);
  await store.drafts.save(live, { text: 'new', cursorUTF16: 0, revision: 1 });
  assert.equal(await store.drafts.read(dead), undefined);
  assert.equal((await store.drafts.read(otherHost))?.text, 'pi old');
});

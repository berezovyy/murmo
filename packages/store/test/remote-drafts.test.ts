// The drafts kind over the store protocol (Claude's path): the client and the
// Node reference handler agree, and a helper that is down never throws into
// the host.
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRemoteDrafts, draftFile, remoteProjectId, type StoreTransport, storeLayout } from '../src/index.ts';
import { handleStoreRequest, openStore, projectIdOf } from '../src/node/index.ts';
import { tempRoots } from './helpers.ts';

test('a draft saved through the protocol is the same 0600 file, offered to the next session and not to its own', async () => {
  // Claude used memory drafts: a SIGKILL lost the draft.
  const t = tempRoots('murmo-remote-drafts-');
  try {
    const store = await openStore({ roots: t.roots });
    const transport: StoreTransport = { request: (message) => handleStoreRequest(store, message) };
    const drafts = createRemoteDrafts(() => transport);
    const repo = join(t.dir, 'repo');
    mkdirSync(join(repo, 'sub', '.git'), { recursive: true });
    mkdirSync(join(repo, 'plain'), { recursive: true });
    const project = await remoteProjectId(transport, join(repo, 'sub'));
    assert.equal(project, projectIdOf(realpathSync(join(repo, 'sub'))));
    assert.equal(await remoteProjectId(transport, 'relative/dir'), undefined);
    assert.notEqual(await remoteProjectId(transport, join(repo, 'plain')), project, 'two folders never share drafts');

    const crashed = { project: project as string, host: 'claude' as const, session: 'claude-a' };
    const text = '👨‍👩‍👧‍👦 draft\nline two';
    const lock = await drafts.holdLock(crashed);
    assert.deepEqual(await drafts.save(crashed, { text, cursorUTF16: 2, revision: 3, now: 1000 }), { status: 'ok' });
    const file = draftFile(storeLayout(t.roots), crashed.project, 'claude', 'claude-a');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal((await drafts.read(crashed))?.text, text);
    const query = { project: crashed.project, host: 'claude' as const, session: 'claude-b', now: 2000 };
    assert.equal(await drafts.findOfferable(query), undefined, 'a live session is never offered');
    assert.deepEqual(await drafts.save(crashed, { text: '', cursorUTF16: 0, revision: 4 }), {
      status: 'denied',
      reason: 'empty',
    });

    // The first session ends; the next session's helper offers its draft.
    await lock.release();
    const next = await openStore({ roots: t.roots });
    const nextDrafts = createRemoteDrafts(() => ({ request: (message) => handleStoreRequest(next, message) }));
    const offered = await nextDrafts.findOfferable(query);
    assert.equal(offered?.text, text);
    assert.equal(offered?.header.cursorUTF16, 2);
  } finally {
    t.remove();
  }
});

test('with the helper down nothing rejects: not saved, nothing offered', async () => {
  // These run in `void` chains off the key path; a rejection there would be unhandled in the host.
  const down: StoreTransport = { request: () => Promise.reject(new Error('ECONNREFUSED')) };
  for (const drafts of [createRemoteDrafts(() => down), createRemoteDrafts(() => undefined)]) {
    const id = { project: 'a'.repeat(64), host: 'claude' as const, session: 'claude-x' };
    assert.equal((await drafts.save(id, { text: 'hello', cursorUTF16: 0, revision: 1 })).status, 'error');
    assert.equal(await drafts.read(id), undefined);
    assert.equal(await drafts.findOfferable({ project: id.project, host: 'claude' }), undefined);
    assert.deepEqual(await drafts.cleanup(), { removed: 0 });
    await drafts.delete(id);
    await drafts.markAttempted(id);
    await (await drafts.holdLock(id)).release();
  }
});

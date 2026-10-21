// Delete, private mode, file modes, the lock and the commands (phase 14 E15,
// E16, E18, lesson 4, vision principle 6). Each test names the failure it catches.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createRemoteStore, type StoreReply, type StoreRequest } from '../src/index.ts';
import { projectCache, projectDrafts } from '../src/layout.ts';
import {
  dataCommand,
  ensurePrivateDir,
  handleStoreRequest,
  lockPath,
  openStore,
  privateCommand,
  type Store,
  withLock,
  writeAtomic,
} from '../src/node/index.ts';
import { pause, type TempRoots, tempRoots, tree } from './helpers.ts';

const cleanup: TempRoots[] = [];
after(() => {
  for (const t of cleanup) t.remove();
});
const fresh = (prefix: string) => {
  const t = tempRoots(prefix);
  cleanup.push(t);
  return t;
};
const id = (name: string) => createHash('sha256').update(name).digest('hex');
const open = (t: TempRoots, configPrivate = false) => openStore({ roots: t.roots, configPrivate });
const ok = (result: { status: string }, what: string) =>
  assert.equal(result.status, 'ok', `${what}: ${JSON.stringify(result)}`);

const A = id('project-a');
const B = id('project-b');

interface Planted {
  readonly marker: string;
  /** The project the marker belongs to, if any. */
  readonly project?: string;
}

/** Plants 100 unique markers in every kind of data, global and per project. */
async function plant(store: Store, t: TempRoots): Promise<Planted[]> {
  const planted: Planted[] = [];
  const marker = (project?: string) => {
    const m = `MURMO-MARKER-${planted.length}-${id(String(Math.random())).slice(0, 8)}`;
    planted.push(project ? { marker: m, project } : { marker: m });
    return m;
  };
  for (let i = 0; i < 10; i++) ok(await store.words.add(marker(), { learned: false }), 'global word');
  for (const p of [A, B]) {
    for (let i = 0; i < 10; i++) ok(await store.words.add(marker(p), { learned: true, projectId: p }), 'project word');
  }
  const storage = store.plugins.forPlugin('marker-plugin');
  for (let i = 0; i < 10; i++) ok(await storage.set(`k${i}`, marker()), 'plugin storage');
  const phrases = store.logs.session('phrases', 'session-1');
  ok(await phrases.append(Array.from({ length: 10 }, () => ({ project: A, text: marker(A) }))), 'phrases A');
  ok(await phrases.append(Array.from({ length: 10 }, () => ({ text: marker() }))), 'phrases global');
  const history = store.logs.session('history', 'session-2');
  ok(await history.append(Array.from({ length: 10 }, () => ({ project: B, text: marker(B) }))), 'history B');
  ok(await history.append(Array.from({ length: 10 }, () => ({ text: `sent ${marker()}` }))), 'history global');
  for (const p of [A, B]) {
    for (const dir of [projectDrafts(store.layout, p), projectCache(store.layout, p)]) {
      const base = dir.startsWith(t.roots.cache) ? t.roots.cache : t.roots.state;
      await ensurePrivateDir(dir, base);
      for (let i = 0; i < 5; i++) await writeAtomic(join(dir, `f${i}`), new TextEncoder().encode(marker(p)));
    }
  }
  assert.equal(planted.length, 100);
  return planted;
}

/** The markers whose bytes are still in some file under the three roots. */
function found(t: TempRoots, planted: readonly Planted[]): Planted[] {
  const all = tree(t.dir)
    .filter((e) => !e.dir)
    .map((e) => e.bytes?.toString('latin1') ?? '')
    .join('\n');
  return planted.filter((p) => all.includes(p.marker));
}

test('data delete --all leaves 0 of 100 planted markers anywhere on disk', async () => {
  // Catches a "clear" that keeps the file, a log segment, a cache or a lock/temp copy (lesson 4, E16).
  const t = fresh('murmo-delete-all-');
  const store = await open(t);
  const planted = await plant(store, t);
  assert.equal(found(t, planted).length, 100, 'every marker is on disk before the delete');
  const watch = store.watchGeneration();
  await watch.changed();
  const lines: string[] = [];
  const code = await dataCommand(['delete', '--all'], {
    store,
    cwd: t.dir,
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
  });
  assert.equal(code, 0, lines.join('\n'));
  assert.match(lines.join('\n'), /^Deleted \d+ files and \d+ entries; rewrote \d+ files\./);
  assert.deepEqual(found(t, planted), []);
  assert.equal(await watch.changed(), true, 'open sessions learn of the delete');
});

test('data delete --project removes exactly that project markers', async () => {
  // Catches a project delete that misses its log entries or drafts, or takes another project's data.
  const t = fresh('murmo-delete-project-');
  const store = await open(t);
  const planted = await plant(store, t);
  const report = await store.delete({ projectId: A });
  assert.ok(report.removedEntries >= 10, JSON.stringify(report));
  const left = found(t, planted);
  assert.deepEqual(
    left.filter((p) => p.project === A),
    [],
  );
  assert.deepEqual(
    left.map((p) => p.marker),
    planted.filter((p) => p.project !== A).map((p) => p.marker),
  );
  // --word removes one word everywhere, and nothing else.
  const word = planted.find((p) => p.project === B)?.marker ?? '';
  await store.delete({ word });
  assert.deepEqual(
    found(t, planted).map((p) => p.marker),
    left.map((p) => p.marker).filter((m) => m !== word),
  );
});

test('private mode changes 0 bytes of learned data across a scripted session', async () => {
  // Catches a learned write (word, log line, plugin storage) that ignores private mode (vision principle 6).
  const t = fresh('murmo-private-');
  const setup = await open(t);
  ok(await setup.words.add('before', { learned: true }), 'setup word');
  ok(await setup.plugins.forPlugin('p').set('k', 1), 'setup storage');
  ok(await setup.logs.session('phrases', 's').append([{ text: 'before' }]), 'setup log');
  const out: string[] = [];
  const context = { store: setup, cwd: t.dir, out: (s: string) => out.push(s), err: (s: string) => out.push(s) };
  assert.equal(await privateCommand(['on'], context), 0);
  assert.match(out.pop() ?? '', /^Private mode is on: Murmo learns nothing and saves no drafts\.$/);
  const before = tree(t.dir);

  for (const store of [await open(t), await open(t, true)]) {
    assert.equal(await store.privacy.isPrivate(), true);
    assert.deepEqual(await store.words.add('learned', { learned: true }), { status: 'denied', reason: 'private mode' });
    assert.equal((await store.plugins.forPlugin('p').set('k', 2)).status, 'denied');
    assert.equal((await store.plugins.forPlugin('p').delete('k')).status, 'denied');
    assert.equal((await store.logs.session('phrases', 's').append([{ text: 'phrase' }])).status, 'denied');
    assert.equal((await store.logs.session('history', 's').append([{ text: 'sent' }])).status, 'denied');
    assert.deepEqual(await handleStoreRequest(store, { op: 'words.add', word: 'x', learned: true }), {
      status: 'denied',
      reason: 'private mode',
    });
    // Reads still work.
    assert.deepEqual(await store.plugins.forPlugin('p').get('k'), { status: 'ok', value: 1 });
  }
  assert.deepEqual(tree(t.dir), before, 'no file was created or changed');

  // [privacy] private = true in the config is private mode even without the flag.
  assert.equal(await privateCommand(['off'], context), 0);
  const configured = await open(t, true);
  assert.equal(await configured.privacy.isPrivate(), true);
  assert.equal(await privateCommand(['status', '--json'], { ...context, store: configured }), 0);
  assert.deepEqual(JSON.parse(out.pop() ?? ''), { flag: false, private: true });
});

function modesUnder(t: TempRoots): string[] {
  const wrong: string[] = [];
  const roots = [t.roots.data, t.roots.state, t.roots.cache];
  for (const e of tree(t.dir)) {
    // Parents above the three roots are not Murmo's and keep the default mode.
    if (!roots.some((r) => e.path === r || e.path.startsWith(`${r}/`))) continue;
    const want = e.dir ? 0o700 : 0o600;
    if (e.mode !== want) wrong.push(`${e.path} ${e.mode.toString(8)}`);
  }
  return wrong;
}

test('every folder is 0700 and every file 0600 after create, repair and rename, under umask 0', async () => {
  // Catches world-readable learned data from a default mode or a wide umask (E15, E16).
  const t = fresh('murmo-modes-');
  const umask = process.umask(0);
  try {
    const store = await open(t);
    await plant(store, t);
    await store.trust.approve({
      projectId: A,
      root: '/r',
      dev: '1',
      ino: '2',
      fingerprint: 'f'.repeat(64),
      approvedAt: 1,
      shortcutCount: 0,
    });
    await store.privacy.setFlag(true);
    assert.deepEqual(modesUnder(t), [], 'after create');
    // Widen a file and its folder, as a careless backup tool or a manual cp would.
    chmodSync(store.layout.words, 0o644);
    chmodSync(store.layout.store, 0o755);
    const reopened = await open(t);
    await reopened.privacy.setFlag(false);
    assert.deepEqual((await reopened.words.list()).length, 10);
    ok(await reopened.words.add('again', { learned: false }), 'write after widen');
    assert.deepEqual(modesUnder(t), [], 'after repair and rename');
    assert.ok(reopened.takeRepairs().includes(store.layout.words), 'the repair is reported');
    assert.deepEqual(reopened.takeRepairs(), [], 'each repair is reported once');
  } finally {
    process.umask(umask);
  }
});

test('the lock is exclusive, reclaimed from a dead holder, and busy for a live one', async () => {
  // Catches two writers inside one record at once, or a crashed writer blocking the store forever.
  const t = fresh('murmo-lock-');
  mkdirSync(t.dir, { recursive: true });
  const target = join(t.dir, 'record.json');
  // A lock left by a process that no longer exists (PID 2^22 + 1 is above macOS and Linux defaults).
  writeFileSync(lockPath(target), JSON.stringify({ pid: 4_194_305, acquiredAt: Date.now(), token: 'dead' }));
  const reclaimed = await withLock(target, async () => 'mine', { timeoutMs: 200 });
  assert.deepEqual(reclaimed, { status: 'ok', value: 'mine' });
  assert.equal(existsSync(lockPath(target)), false, 'released');
  // A live holder (this process, by another token) makes a second taker busy.
  writeFileSync(lockPath(target), JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token: 'live' }));
  assert.deepEqual(await withLock(target, async () => 'x', { timeoutMs: 50, retryMs: 5 }), { status: 'busy' });
  // ...until it is older than the stale limit.
  await pause(30);
  assert.deepEqual(await withLock(target, async () => 'late', { timeoutMs: 50, staleMs: 20 }), {
    status: 'ok',
    value: 'late',
  });
  // Calls in one process queue instead of failing.
  let inside = 0;
  let most = 0;
  await Promise.all(
    Array.from({ length: 20 }, () =>
      withLock(target, async () => {
        inside++;
        most = Math.max(most, inside);
        await pause(1);
        inside--;
      }),
    ),
  );
  assert.equal(most, 1);
});

test('data show lists every kind with entries and escapes hostile paths', async () => {
  // Catches data Murmo wrote but review cannot see, and a path that repaints the terminal.
  const t = fresh('murmo-show-');
  const store = await open(t);
  await plant(store, t);
  writeFileSync(join(store.layout.store, 'stray\u001b[31m.txt'), 'x');
  const out: string[] = [];
  const context = { store, cwd: t.dir, out: (s: string) => out.push(s), err: (s: string) => out.push(s) };
  assert.equal(await dataCommand(['show', '--json'], context), 0);
  const rows = (JSON.parse(out.pop() ?? '') as { rows: { kind: string; entries?: number; scope: string }[] }).rows;
  const kinds = new Set(rows.map((r) => r.kind));
  for (const kind of ['words', 'plugins', 'logs', 'drafts', 'vocab', 'other']) assert.ok(kinds.has(kind), kind);
  assert.equal(rows.find((r) => r.kind === 'words' && r.scope === 'global')?.entries, 10);
  assert.equal(await dataCommand(['show'], context), 0);
  const table = out.pop() ?? '';
  assert.match(table, /^kind {2}/);
  assert.ok(!table.includes('\u001b'), 'the escape byte reached the table');
  assert.equal(await dataCommand(['delete', '--kind', 'nope'], context), 2);
  assert.equal(await dataCommand(['delete', '--all', '--word', 'x'], context), 2);
  assert.ok(statSync(store.layout.words).isFile(), 'a refused command deletes nothing');
});

test('a Claude session keeps working in memory when the helper is down', async () => {
  // Catches plugin storage failing, or learned data being written somewhere, while the helper is unreachable.
  const t = fresh('murmo-remote-');
  const store = await open(t);
  const sent: StoreRequest[] = [];
  let up = true;
  const remote = createRemoteStore({
    async request(message): Promise<StoreReply> {
      if (!up) throw new Error('ECONNREFUSED');
      sent.push(message);
      return handleStoreRequest(store, message);
    },
  });
  const storage = remote.forPlugin('p');
  assert.deepEqual(await storage.set('k', 1), { status: 'ok' });
  assert.deepEqual(
    await store.plugins.forPlugin('p').get('k'),
    { status: 'ok', value: 1 },
    'written through the helper',
  );
  assert.equal(remote.degraded, false);
  up = false;
  assert.deepEqual(await storage.set('k', 2), { status: 'ok' });
  assert.deepEqual(await storage.get('k'), { status: 'ok', value: 2 });
  assert.equal(remote.degraded, true);
  assert.equal(await remote.isPrivate(), true, 'nothing is learned while degraded');
  assert.equal((await remote.addWord('w', { learned: true })).status, 'error');
  assert.deepEqual(await store.plugins.forPlugin('p').get('k'), { status: 'ok', value: 1 }, 'the disk is untouched');
});

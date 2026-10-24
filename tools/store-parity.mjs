// Store parity (phase 14): the Rust store (packages/store/rust, the phase 10
// helper's file layer) and @murmo/store share one on-disk format, one lock and
// one protocol, so either can write while the other reads.
//
// - crash: the Rust writer killed by SIGKILL 20 times per record kind leaves
//   a whole record that Node reads, and no temp after the next Node open.
// - sets: 6 Node and 6 Rust processes x 200 sets on their own keys of one
//   namespace lose no key.
// - protocol: the same requests give the same replies from the Node handler
//   (handleStoreRequest) and the Rust one (Store::handle).
// - draft locks: a draft session lock held by a live Rust process reads as
//   live to Node and the other way round (same lock body and start token), so
//   neither offers a running session's draft or hides a dead one's.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rustExample } from './config-parity.mjs';

const RUNS = 20;

async function crashLeg(binary, h, store) {
  const t = h.tempRoots('murmo-store-parity-crash-');
  try {
    const layout = store.storeLayout(t.roots);
    for (const kind of ['trust', 'words', 'plugin', 'meta']) {
      const path = kind === 'plugin' ? store.pluginRecordPath(layout, 'crash') : layout[kind];
      for (let run = 0; run < RUNS; run++) {
        const child = h.startWriter(binary, [...h.rootArgs(t.roots), 'write-loop', kind]);
        const exited = h.finished(child);
        while (!existsSync(path) && child.exitCode === null) await h.pause(1);
        await h.pause(Math.floor(Math.random() * 25));
        await h.kill(child);
        const { signal, stderr } = await exited;
        assert.equal(signal, 'SIGKILL', `${kind} run ${run}: the Rust writer stopped by itself: ${stderr}`);
        const read = await store.readRecord(kind, path);
        assert.equal(read.status, 'ok', `${kind} run ${run}: ${JSON.stringify(read)}`);
        await store.openStore({ roots: t.roots });
        const temps = readdirSync(dirname(path)).filter(store.isTempName);
        assert.deepEqual(temps, [], `${kind} run ${run}: a Rust temp survived the next Node open`);
      }
    }
    return 4 * RUNS;
  } finally {
    t.remove();
  }
}

async function setsLeg(binary, h, store) {
  const t = h.tempRoots('murmo-store-parity-sets-');
  try {
    const keys = 5;
    const rounds = 40;
    const children = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0
        ? h.startChild(t.roots, 'sets', 'shared', `p${i}`, String(keys), String(rounds))
        : h.startWriter(binary, [...h.rootArgs(t.roots), 'sets', 'shared', `p${i}`, String(keys), String(rounds)]),
    );
    const results = await Promise.all(children.map(h.finished));
    assert.deepEqual(
      results.map((r) => r.code),
      Array(12).fill(0),
      results.map((r) => r.stderr).join(''),
    );
    const storage = (await store.openStore({ roots: t.roots })).plugins.forPlugin('shared');
    let lost = 0;
    for (let i = 0; i < 12; i++) {
      for (let k = 0; k < keys; k++) {
        const got = await storage.get(`p${i}-${k}`);
        if (!(got.status === 'ok' && got.value === rounds - 1)) lost++;
      }
    }
    assert.equal(lost, 0, `${lost} of 60 keys lost with mixed Node and Rust writers`);
    return 12 * keys * rounds;
  } finally {
    t.remove();
  }
}

const PROJECT = 'b'.repeat(64);
const draftId = (session, project = PROJECT, host = 'claude') => ({ project, host, session });
const save = (session, text, now, extra = {}) => ({
  op: 'drafts.save',
  draft: draftId(session),
  text,
  cursorUTF16: text.length,
  revision: 1,
  now,
  ...extra,
});

/** Draft rescue requests; `cwd` is a directory outside any repository. */
function draftRequests(cwd) {
  return [
    { op: 'project.id', cwd: 'relative/dir' },
    { op: 'project.id', cwd },
    { op: 'project.id', cwd: join(cwd, 'missing') },
    save('s-dead', 'crash draft\n你好 👨\u200d👩\u200d👧', 1_000_000),
    { op: 'drafts.read', draft: draftId('s-dead') },
    { op: 'drafts.read', draft: draftId('s-none') },
    // A dead session's draft (no lock) is offered to another session, never to its own.
    { op: 'drafts.offer', project: PROJECT, host: 'claude', session: 's-live', now: 1_000_001 },
    { op: 'drafts.offer', project: PROJECT, host: 'claude', session: 's-dead', now: 1_000_001 },
    { op: 'drafts.offer', project: PROJECT, host: 'claude', now: 1_000_000 + 86_400_000 },
    save('s-live', '', 1_000_002),
    save('s-live', 'x'.repeat(65_537), 1_000_002),
    save('s-live', '😀', 1_000_002, { cursorUTF16: 1 }),
    save('s-live', 'ok', 1_000_002, { revision: 1.5 }),
    { ...save('s-live', 'bad project', 1_000_002), draft: draftId('s-live', 'B'.repeat(64)) },
    { ...save('s-live', 'bad host', 1_000_002), draft: draftId('s-live', PROJECT, 'vim') },
    { ...save('s-live', 'bad session', 1_000_002), draft: draftId('s.live') },
    { op: 'drafts.lock', draft: draftId('s-live') },
    { op: 'drafts.lock', draft: draftId('s-live') },
    // Saving sweeps dead sessions' drafts; the held lock keeps this one live.
    save('s-live', 'live draft', 1_000_003),
    { op: 'drafts.read', draft: draftId('s-dead') },
    { op: 'drafts.offer', project: PROJECT, host: 'claude', session: 's-other', now: 1_000_004 },
    { op: 'drafts.unlock', draft: draftId('s-live') },
    { op: 'drafts.unlock', draft: draftId('s-live') },
    { op: 'drafts.offer', project: PROJECT, host: 'claude', session: 's-other', now: 1_000_004 },
    { op: 'drafts.markAttempted', draft: draftId('s-live'), now: 1_000_005 },
    { op: 'drafts.read', draft: draftId('s-live') },
    { op: 'drafts.offer', project: PROJECT, host: 'claude', session: 's-other', now: 1_000_006 },
    { op: 'drafts.markAttempted', draft: draftId('s-none') },
    // pid 1 is always alive and never ours: its session is still running.
    { writeLock: { session: 's-init', body: { pid: 1, start: '', acquiredAt: 1, token: 't' } } },
    { op: 'drafts.lock', draft: draftId('s-init') },
    save('s-old', 'old draft', 0, { draft: draftId('s-old', PROJECT, 'pi') }),
    { op: 'drafts.offer', project: PROJECT, host: 'pi', now: 1 },
    { op: 'drafts.cleanup', now: 86_400_000 },
    { op: 'drafts.offer', project: PROJECT, host: 'pi', now: 1 },
    { op: 'drafts.offer', project: 'nope', host: 'pi' },
    { op: 'drafts.offer', project: PROJECT, host: 'vim' },
    { op: 'drafts.delete', draft: draftId('s-live') },
    { op: 'drafts.read', draft: draftId('s-live') },
    { op: 'drafts.delete', draft: draftId('s.bad') },
    { op: 'drafts.save', draft: draftId('s-x'), text: 'a', cursorUTF16: 1 },
    { op: 'drafts.save', draft: draftId('s-x'), text: 'a', cursorUTF16: 1, revision: 0, now: null },
    { op: 'drafts.read', draft: { project: PROJECT, host: 'claude' } },
    { op: 'drafts.offer', project: PROJECT, host: 'claude', session: 7 },
    { op: 'drafts.cleanup', now: 'soon' },
    { op: 'drafts.nope', draft: draftId('s-x') },
    { op: 'project.id' },
    // A lone surrogate (half an emoji) is not UTF-8: both stores refuse the
    // request whole, so neither saves a draft it would restore as U+FFFD.
    { op: 'drafts.save', draft: draftId('s-half'), text: 'half \ud83d', cursorUTF16: 0, revision: 1, now: 1 },
    { op: 'drafts.read', draft: draftId('s-half') },
    { op: 'storage.set', plugin: 'p', key: 'k\udc00', value: 1 },
  ];
}

/** Requests that cover every op and every refusal both handlers can give. */
function requests(cwd) {
  const big = 'x'.repeat(70_000);
  return [
    ...draftRequests(cwd),
    { op: 'generation.get' },
    { op: 'private.get' },
    { op: 'storage.get', plugin: 'p', key: 'missing' },
    { op: 'storage.set', plugin: 'p', key: 'k', value: { nested: [1, 'two', null] } },
    { op: 'storage.get', plugin: 'p', key: 'k' },
    { op: 'storage.set', plugin: 'p', key: '', value: 1 },
    { op: 'storage.set', plugin: 'p', key: 'big', value: big },
    ...Array.from({ length: 64 }, (_, i) => ({ op: 'storage.set', plugin: 'q', key: `k${i}`, value: i })),
    { op: 'storage.delete', plugin: 'q', key: 'k0' },
    { op: 'storage.delete', plugin: 'q', key: 'k0' },
    { op: 'storage.set', plugin: '@scope/name', key: 'k', value: true },
    { op: 'words.add', word: 'kubectl', learned: false },
    { op: 'words.add', word: 'kubectl', learned: true },
    { op: 'words.add', word: 'two words', learned: false },
    { op: 'words.add', word: 'zero\u{200b}width', learned: false },
    { op: 'words.add', word: 'x'.repeat(65), learned: false },
    { op: 'words.add', word: 'proj', learned: true, projectId: 'a'.repeat(64) },
    { op: 'log.append', kind: 'phrases', session: 's-1', lines: ['{"text":"hello"}'] },
    { op: 'log.append', kind: 'phrases', session: 's-1', lines: ['not json'] },
    { op: 'log.append', kind: 'nope', session: 's-1', lines: [] },
    { op: 'storage.set', plugin: 'p', key: 'k' },
    { op: 'words.add', word: 'w', learned: 'yes' },
    { op: 'unknown' },
    'not an object',
    { flag: 'on' },
    { op: 'private.get' },
    { op: 'words.add', word: 'learned', learned: true },
    { op: 'storage.set', plugin: 'p', key: 'k', value: 2 },
    { op: 'log.append', kind: 'history', session: 's-2', lines: ['{"text":"sent"}'] },
    { op: 'storage.get', plugin: 'p', key: 'k' },
    // Private mode saves no draft and removes this session's.
    save('s-private', 'private draft', 2_000_000),
    { op: 'drafts.read', draft: draftId('s-private') },
  ];
}

async function protocolLeg(binary, h, store) {
  const [jsRoots, rustRoots] = [h.tempRoots('murmo-store-parity-js-'), h.tempRoots('murmo-store-parity-rs-')];
  const cwd = mkdtempSync(join(tmpdir(), 'murmo-store-parity-cwd-'));
  try {
    const node = await store.openStore({ roots: jsRoots.roots });
    const rust = spawn(binary, [...h.rootArgs(rustRoots.roots), 'handle'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buffered = '';
    const waiting = [];
    rust.stdout.on('data', (chunk) => {
      buffered += chunk.toString();
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        waiting.shift()?.(JSON.parse(buffered.slice(0, at)));
        buffered = buffered.slice(at + 1);
      }
    });
    const ask = (message) =>
      new Promise((resolve) => {
        waiting.push(resolve);
        rust.stdin.write(`${JSON.stringify(message)}\n`);
      });
    const list = requests(cwd);
    try {
      for (const [i, message] of list.entries()) {
        if (message && typeof message === 'object' && 'writeLock' in message) {
          for (const t of [jsRoots, rustRoots]) {
            const dir = join(store.projectDrafts(store.storeLayout(t.roots), PROJECT), 'claude');
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            writeFileSync(
              join(dir, `${message.writeLock.session}.lock`),
              `${JSON.stringify(message.writeLock.body)}\n`,
              {
                mode: 0o600,
              },
            );
          }
          continue;
        }
        if (message && typeof message === 'object' && 'flag' in message) {
          // Private mode on for both stores, as `murmo private on` would.
          for (const t of [jsRoots, rustRoots]) {
            await (await store.openStore({ roots: t.roots })).privacy.setFlag(true);
          }
          continue;
        }
        const js = JSON.parse(JSON.stringify(await store.handleStoreRequest(node, message)));
        const rs = await ask(message);
        assert.deepEqual(rs, js, `request ${i} ${JSON.stringify(message).slice(0, 80)}: Rust and Node replies differ`);
      }
    } finally {
      rust.stdin.end();
      await h.finished(rust);
    }
    // Both wrote the same records.
    const words = async (t) => (await store.openStore({ roots: t.roots })).words.list();
    assert.deepEqual(await words(rustRoots), await words(jsRoots));
    return list.filter((m) => !(m && typeof m === 'object' && ('flag' in m || 'writeLock' in m))).length;
  } finally {
    jsRoots.remove();
    rustRoots.remove();
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * One store, a live Rust process and this Node process each holding a draft
 * session lock: each must judge the other's lock live (pid and start token),
 * and offer the draft once its owner lets go.
 */
async function draftLockLeg(binary, h, store) {
  const t = h.tempRoots('murmo-store-parity-locks-');
  const rust = spawn(binary, [...h.rootArgs(t.roots), 'handle'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buffered = '';
  const waiting = [];
  rust.stdout.on('data', (chunk) => {
    buffered += chunk.toString();
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      waiting.shift()?.(JSON.parse(buffered.slice(0, at)));
      buffered = buffered.slice(at + 1);
    }
  });
  const ask = (message) =>
    new Promise((resolve) => {
      waiting.push(resolve);
      rust.stdin.write(`${JSON.stringify(message)}\n`);
    });
  try {
    const node = await store.openStore({ roots: t.roots });
    const query = { project: PROJECT, host: 'claude', session: 'probe', now: 1_000_100 };
    assert.deepEqual(await ask({ op: 'drafts.lock', draft: draftId('rs') }), { status: 'ok' });
    assert.deepEqual(await ask(save('rs', 'rust draft', 1_000_000)), { status: 'ok' });
    const held = await node.drafts.holdLock(draftId('js'));
    assert.deepEqual(
      await node.drafts.save(draftId('js'), { text: 'node draft', cursorUTF16: 0, revision: 1, now: 1_000_001 }),
      {
        status: 'ok',
      },
    );
    assert.equal(await node.drafts.findOfferable(query), undefined, 'Node offered a live Rust session draft');
    assert.deepEqual(
      await ask({ op: 'drafts.offer', ...query }),
      { status: 'ok' },
      'Rust offered a live Node session draft',
    );
    await held.release();
    assert.equal((await ask({ op: 'drafts.offer', ...query })).value?.text, 'node draft');
    assert.deepEqual(await ask({ op: 'drafts.unlock', draft: draftId('rs') }), { status: 'ok' });
    assert.equal((await node.drafts.findOfferable({ ...query, session: 'js' }))?.text, 'rust draft');
    return 2;
  } finally {
    rust.stdin.end();
    await h.finished(rust);
    t.remove();
  }
}

/** @returns {Promise<{crashRuns: number, sets: number, requests: number, draftLocks: number}>} */
export async function storeParity() {
  const binary = rustExample('murmo-store', 'store-tool');
  const h = await import('../packages/store/test/helpers.ts');
  const node = await import('../packages/store/src/node/index.ts');
  const portable = await import('../packages/store/src/index.ts');
  const files = await import('../packages/store/src/node/files.ts');
  const store = { ...portable, ...node, isTempName: files.isTempName };
  return {
    crashRuns: await crashLeg(binary, h, store),
    sets: await setsLeg(binary, h, store),
    requests: await protocolLeg(binary, h, store),
    draftLocks: await draftLockLeg(binary, h, store),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await storeParity();
  console.log(
    `store parity: ${r.crashRuns} Rust crash runs read back whole, ${r.sets} mixed sets lost nothing, ${r.requests} protocol replies agree, ${r.draftLocks} draft locks judged live across Node and Rust`,
  );
}

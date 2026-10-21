// Crash safety and concurrent writers (phase 14 E9, E14, E24), with real
// processes killed by SIGKILL. tools/store-parity.mjs repeats the crash and
// concurrency runs with the Rust writer mixed in.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { decodeDraft, draftFile } from '../src/index.ts';
import { pluginRecordPath, storeLayout } from '../src/layout.ts';
import { isTempName } from '../src/node/files.ts';
import { openStore, readRecord, readSnapshotSet } from '../src/node/index.ts';
import { decodeRecord, type RecordKind } from '../src/records.ts';
import { finished, kill, pause, startChild, type TempRoots, tempRoots, whenReady } from './helpers.ts';

const cleanup: TempRoots[] = [];
after(() => {
  for (const t of cleanup) t.remove();
});
const fresh = (prefix: string) => {
  const t = tempRoots(prefix);
  cleanup.push(t);
  return t;
};

const RUNS = 20;
const KINDS: readonly [string, RecordKind][] = [
  ['trust', 'trust'],
  ['words', 'words'],
  ['plugin', 'plugin'],
  ['meta', 'meta'],
];

for (const [name, kind] of KINDS) {
  test(`SIGKILL during ${name} writes leaves a whole record and no temp after the next open (20 runs)`, async () => {
    // Catches a torn record or an orphan temp after a crash (E14: the prototype's fixed .tmp name).
    const t = fresh(`murmo-crash-${name}-`);
    const layout = storeLayout(t.roots);
    const path =
      name === 'plugin' ? pluginRecordPath(layout, 'crash') : (layout as unknown as Record<string, string>)[name];
    assert.ok(path);
    const dir = dirname(path);
    let tempsSeen = 0;
    for (let run = 0; run < RUNS; run++) {
      const child = startChild(t.roots, 'write-loop', name);
      await whenReady(child);
      await pause(Math.floor(Math.random() * 25));
      await kill(child);
      const read: { readonly status: string } = await readRecord(kind, path);
      assert.equal(read.status, 'ok', `run ${run}: ${JSON.stringify(read)}`);
      // Every non-temp file in the folder is whole: the record itself, or the lock.
      for (const file of readdirSync(dir)) {
        if (isTempName(file)) {
          tempsSeen++;
          continue;
        }
        const text = readFileSync(join(dir, file), 'utf8');
        if (file.endsWith('.lock')) assert.doesNotThrow(() => JSON.parse(text), `run ${run}: torn lock ${file}`);
        else assert.ok(decodeRecord(kind, text), `run ${run}: partial ${file}`);
      }
      await openStore({ roots: t.roots });
      assert.deepEqual(readdirSync(dir).filter(isTempName), [], `run ${run}: a temp survived the next open`);
    }
    // Not a requirement, but a run where no kill ever landed mid-write would test nothing.
    if (tempsSeen === 0) process.stdout.write(`# ${name}: no kill landed between temp and rename\n`);
  });
}

test('SIGKILL during a three-file snapshot swap never leaves current on an incomplete set (20 runs)', async () => {
  // Catches a half-swapped index that phase 35 would serve, and a reader mixing two generations (E24).
  const t = fresh('murmo-swap-');
  const directory = join(t.roots.data, 'store', 'v1', 'swap-test');
  for (let run = 0; run < RUNS; run++) {
    const child = startChild(t.roots, 'swap-loop', directory);
    await whenReady(child);
    const stopAt = Date.now() + 5 + Math.floor(Math.random() * 40);
    let reads = 0;
    while (Date.now() < stopAt) {
      const read = await readSnapshotSet(directory);
      assert.equal(read.status, 'ok', `run ${run}: ${JSON.stringify(read)}`);
      if (read.status !== 'ok') break;
      const tags = new Set(Object.values(read.files).map((f) => f.header.tag));
      assert.deepEqual([Object.keys(read.files).sort(), tags.size], [['a.snap', 'b.snap', 'c.snap'], 1], `run ${run}`);
      reads++;
    }
    await kill(child);
    assert.ok(reads > 0);
    const after = await readSnapshotSet(directory);
    assert.equal(after.status, 'ok', `run ${run} after kill: ${JSON.stringify(after)}`);
    if (after.status === 'ok') {
      const tags = new Set(Object.values(after.files).map((f) => f.header.tag));
      assert.deepEqual([Object.keys(after.files).length, tags.size], [3, 1], `run ${run} after kill`);
    }
  }
});

test('SIGKILL during draft saves leaves a whole snapshot and no temp after cleanup (20 runs, r9-history § 3)', async () => {
  const t = fresh('murmo-crash-draft-');
  const project = createHash('sha256').update('crash-draft').digest('hex');
  const id = { project, host: 'fake' as const, session: 'crash' };
  const store0 = await openStore({ roots: t.roots });
  assert.equal((await store0.drafts.save(id, { text: 'seed', cursorUTF16: 4, revision: 0 })).status, 'ok');
  const path = draftFile(store0.layout, project, 'fake', 'crash');
  const dir = dirname(path);
  let tempsSeen = 0;
  for (let run = 0; run < RUNS; run++) {
    const child = startChild(t.roots, 'draft-loop', project, 'fake', 'crash');
    await whenReady(child);
    await pause(Math.floor(Math.random() * 25));
    await kill(child);
    const bytes = readFileSync(path);
    const decoded = decodeDraft(bytes);
    assert.equal(decoded.ok, true, `run ${run}: ${decoded.ok ? '' : decoded.reason}`);
    for (const file of readdirSync(dir)) {
      if (isTempName(file)) tempsSeen++;
    }
    await store0.drafts.cleanup();
    assert.deepEqual(readdirSync(dir).filter(isTempName), [], `run ${run}: a temp survived cleanup`);
  }
  if (tempsSeen === 0) process.stdout.write('# draft: no kill landed between temp and rename\n');
});

test('12 processes x 200 sets on their own keys of one namespace lose no key', async () => {
  // Catches last-writer-wins saves of a whole namespace (r12 createFileStorage, r14 D4, E9).
  const t = fresh('murmo-sets-');
  const processes = 12;
  const keys = 5;
  const rounds = 40; // 5 keys x 40 rounds = 200 sets each; 60 keys fit the 64-key quota.
  const children = Array.from({ length: processes }, (_, i) =>
    startChild(t.roots, 'sets', 'shared', `p${i}`, String(keys), String(rounds)),
  );
  const results = await Promise.all(children.map(finished));
  assert.deepEqual(
    results.map((r) => r.code),
    Array(processes).fill(0),
    results.map((r) => r.stderr).join(''),
  );
  const storage = (await openStore({ roots: t.roots })).plugins.forPlugin('shared');
  let lost = 0;
  for (let i = 0; i < processes; i++) {
    for (let k = 0; k < keys; k++) {
      const got = await storage.get(`p${i}-${k}`);
      if (!(got.status === 'ok' && got.value === rounds - 1)) lost++;
    }
  }
  assert.equal(lost, 0, `${lost} of ${processes * keys} keys lost or stale`);
});

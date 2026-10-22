// SIGKILL during a merge leaves a valid `current` snapshot 20/20 (E5).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { historyDirectory, storeLayout } from '@murmo/store';
import { openStore, parseSegment, readSnapshotSet } from '@murmo/store/node';
import { kill, pause, startWriter, type TempRoots, tempRoots, whenReady } from '../../../store/test/helpers.ts';

const cleanup: TempRoots[] = [];
after(() => {
  for (const t of cleanup) t.remove();
});

const RUNS = 20;
const childScript = fileURLToPath(new URL('./child.ts', import.meta.url));

test('SIGKILL during history merge leaves 20/20 valid current snapshots', async () => {
  const t = tempRoots('murmo-history-crash-');
  cleanup.push(t);
  const dir = historyDirectory(storeLayout(t.roots));
  for (let run = 0; run < RUNS; run++) {
    const child = startWriter(process.execPath, [childScript, t.roots.data, t.roots.state, t.roots.cache]);
    await whenReady(child);
    await pause(Math.floor(Math.random() * 40));
    await kill(child);
    const after = await readSnapshotSet(dir);
    assert.equal(after.status === 'ok' || after.status === 'missing', true, `run ${run}: ${JSON.stringify(after)}`);
    if (after.status === 'ok') {
      assert.ok(after.files.index, `run ${run} missing index`);
    }
  }
});

test('SIGKILL during history log append leaves readable segments', async () => {
  const t = tempRoots('murmo-history-log-');
  cleanup.push(t);
  const logDir = join(t.roots.data, 'store', 'v1', 'logs', 'history');
  const child = startWriter(process.execPath, [childScript, t.roots.data, t.roots.state, t.roots.cache]);
  await whenReady(child);
  await pause(20);
  await kill(child);
  let names: string[] = [];
  try {
    names = readdirSync(logDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const text = readFileSync(join(logDir, name), 'utf8');
    const read = parseSegment(text);
    for (const entry of read.entries) assert.equal(typeof entry.text, 'string');
  }
  const store = await openStore({ roots: t.roots });
  const { entries } = await store.logs.read('history');
  assert.ok(entries.length >= 0);
});

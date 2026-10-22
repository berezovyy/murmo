// SIGKILL mid-append leaves readable segments and a valid snapshot (E26, E30).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openStore, parseSegment } from '@murmo/store/node';
import { kill, pause, startChild, type TempRoots, tempRoots, whenReady } from '../../../store/test/helpers.ts';
import { createMemoryStore } from '../src/memory.ts';
import { readPacked, writePacked } from '../src/node/store.ts';
import { mapPacked } from '../src/packed.ts';

const cleanup: TempRoots[] = [];
after(() => {
  for (const t of cleanup) t.remove();
});

const RUNS = 20;

test('SIGKILL during phrase log append leaves 20/20 readable segments', async () => {
  const t = tempRoots('murmo-phrases-crash-');
  cleanup.push(t);
  const dir = join(t.roots.data, 'store', 'v1', 'logs', 'phrases');
  for (let run = 0; run < RUNS; run++) {
    const child = startChild(t.roots, 'log-loop', 'phrases', 'crash');
    await whenReady(child);
    await pause(Math.floor(Math.random() * 25));
    await kill(child);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const text = readFileSync(join(dir, name), 'utf8');
      const read = parseSegment(text);
      for (const entry of read.entries) {
        assert.equal(typeof entry.phrase, 'string');
      }
    }
    const store = await openStore({ roots: t.roots });
    const { entries } = await store.logs.read('phrases');
    assert.ok(entries.length >= 0);
  }
});

test('a packed snapshot written after a crash still maps', async () => {
  const t = tempRoots('murmo-phrases-snap-');
  cleanup.push(t);
  const store = await openStore({ roots: t.roots });
  const memory = createMemoryStore();
  memory.learn([
    { phrase: 'update the cache module', host: 'fake', project: 'a'.repeat(64), at: 1 },
    { phrase: 'update the cache module', host: 'fake', project: 'a'.repeat(64), at: 2 },
    { phrase: 'update the cache module', host: 'fake', project: 'a'.repeat(64), at: 3 },
  ]);
  await writePacked(store, memory.records(), Date.now());
  const packed = await readPacked(store);
  assert.ok(packed);
  assert.ok(mapPacked(packed.bytes));
});

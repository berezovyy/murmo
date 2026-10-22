// 0 bytes of any ;? query text under the data dir after a scripted search (E11).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createMemoryStore } from '../src/memory.ts';
import { persistEvents } from '../src/node/store.ts';
import { PROJECT, tempStore, withHistory } from './helpers.ts';

const cleanup: { remove: () => void }[] = [];
after(() => {
  for (const t of cleanup) t.remove();
});

function walk(root: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(root, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

test('a ;? search query is not written under the data dir', async () => {
  const t = tempStore();
  cleanup.push(t);
  const store = await t.store;
  const saved = 'Review the OutboxWorker drain_queue path for timeouts.';
  await persistEvents(store, 's1', [{ text: saved, host: 'fake', project: PROJECT, at: 1 }]);
  const memory = createMemoryStore();
  memory.record([{ text: saved, host: 'pi', project: PROJECT, at: 1 }]);
  const h = await withHistory(memory, { enabled: true });
  const query = 'uniquesearchxyzzy';
  await h.driver.type(`;?${query}`);
  await h.driver.settle();
  await h.session?.dispose();
  for (const file of walk(store.layout.roots.data)) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    assert.equal(text.includes(query), false, file);
  }
});

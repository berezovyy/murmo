// forget/wipe delete from disk: grep of the data dir finds 0 copies (E28).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { phrasesCommand } from '../src/node/commands.ts';
import { loadRecords, persistEvents, writePacked } from '../src/node/store.ts';
import { PROJECT, tempStore } from './helpers.ts';

const cleanup: { remove: () => void }[] = [];
after(() => {
  for (const t of cleanup) t.remove();
});

const MARKER = 'uniqueclausexyz for wipe audit now';

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

test('after forget, the phrase text appears in 0 files under the data dir', async () => {
  const t = tempStore();
  cleanup.push(t);
  const store = await t.store;
  await persistEvents(store, 's1', [{ phrase: MARKER, host: 'fake', project: PROJECT, at: 1 }]);
  await persistEvents(store, 's1', [
    { phrase: MARKER, host: 'fake', project: PROJECT, at: 2 },
    { phrase: MARKER, host: 'fake', project: PROJECT, at: 3 },
  ]);
  const records = await loadRecords(store);
  await writePacked(store, records, Date.now());
  const id = records[0]?.id;
  assert.ok(id);
  const io = { out: '', err: '' };
  const code = await phrasesCommand(['forget', id], {
    store,
    cwd: t.dir,
    out: (s) => {
      io.out += s;
    },
    err: (s) => {
      io.err += s;
    },
  });
  assert.equal(code, 0, io.err);
  for (const file of walk(store.layout.roots.data)) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    assert.equal(text.includes('uniqueclausexyz'), false, file);
  }
});

test('wipe --all removes every learned clause from disk', async () => {
  const t = tempStore();
  cleanup.push(t);
  const store = await t.store;
  await persistEvents(store, 's1', [{ phrase: MARKER, host: 'fake', project: PROJECT, at: 1 }]);
  const io = { out: '', err: '' };
  const code = await phrasesCommand(['wipe', '--all'], {
    store,
    cwd: t.dir,
    out: (s) => {
      io.out += s;
    },
    err: (s) => {
      io.err += s;
    },
  });
  assert.equal(code, 0, io.err);
  for (const file of walk(store.layout.roots.data)) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    assert.equal(text.includes('uniqueclausexyz'), false, file);
  }
});

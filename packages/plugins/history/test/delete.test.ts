// forget/wipe delete from disk: grep of the data dir finds 0 copies (E14).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promptId } from '../src/memory.ts';
import { historyCommand } from '../src/node/commands.ts';
import { persistEvents, writePacked } from '../src/node/store.ts';
import { PROJECT, tempStore } from './helpers.ts';

const cleanup: { remove: () => void }[] = [];
after(() => {
  for (const t of cleanup) t.remove();
});

const MARKER = 'uniquehistoryxyz drain_queue for wipe audit now';

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

test('after forget, the prompt text appears in 0 files under the data dir', async () => {
  const t = tempStore();
  cleanup.push(t);
  const store = await t.store;
  await persistEvents(store, 's1', [{ text: MARKER, host: 'fake', project: PROJECT, at: 1 }]);
  const id = promptId(MARKER);
  const io = { out: '', err: '' };
  const code = await historyCommand(['forget', id], {
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
    assert.equal(text.includes('uniquehistoryxyz'), false, file);
  }
});

test('wipe --all removes every saved prompt from disk', async () => {
  const t = tempStore();
  cleanup.push(t);
  const store = await t.store;
  await persistEvents(store, 's1', [{ text: MARKER, host: 'fake', project: PROJECT, at: 1 }]);
  await writePacked(
    store,
    [{ id: 0, text: MARKER, count: 1, lastAt: 1, events: [{ host: 'fake', project: PROJECT, at: 1 }] }],
    Date.now(),
  );
  const io = { out: '', err: '' };
  const code = await historyCommand(['wipe', '--all'], {
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
    assert.equal(text.includes('uniquehistoryxyz'), false, file);
  }
});

// Draft rescue and the session identity through the real Pi wiring (startPiSession) on the fake Pi:
// the store is the file store under a throwaway XDG state folder.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { loadRecords } from '@murmo/plugin-history/node';
import { openStore, projectIdOfCwd, storeRootsFromEnv } from '@murmo/store/node';
import { startPiSession } from '../src/session.ts';
import { createFakePi, FakePiEditor, fakeTuiApi } from './fake-pi.ts';

const root = mkdtempSync(join(tmpdir(), 'murmo-pi-rescue-'));
const project = join(root, 'project');
const saved: Record<string, string | undefined> = {};
const VARS = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];

before(() => {
  mkdirSync(join(project, '.git'), { recursive: true });
  for (const name of VARS) saved[name] = process.env[name];
  process.env.HOME = join(root, 'home');
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.XDG_DATA_HOME = join(root, 'data');
  process.env.XDG_STATE_HOME = join(root, 'state');
  process.env.XDG_CACHE_HOME = join(root, 'cache');
});
after(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(root, { recursive: true, force: true });
});

const start = (env = createFakePi()) =>
  startPiSession({
    Base: FakePiEditor,
    tuiApi: fakeTuiApi,
    ctx: env.ctx,
    pi: env.host,
    version: '1.3.0',
    cwd: project,
  }).then((started) => ({ env, started }));

test('a crashed session draft is offered on the empty prompt at startup, and Tab restores it (r3pic-2)', async () => {
  // Pi showed nothing until a character was typed and deleted: the found
  // snapshot was painted only by a later change to an empty draft.
  const store = await openStore({ roots: storeRootsFromEnv() });
  const text = 'line one of the crash draft\nline two';
  const dead = { project: await projectIdOfCwd(project), host: 'pi' as const, session: 'pi-dead-session' };
  await store.drafts.save(dead, { text, cursorUTF16: text.length, revision: 4 });

  const { env, started } = await start();
  try {
    await started.session.settle();
    const rows = env.editor.render(100);
    assert.ok(
      rows.some((row) => row.includes('Restore your last draft from')),
      `no offer at startup:\n${rows.join('\n')}`,
    );
    // The ghost's first cell is under Pi's fake cursor, so match after it.
    assert.ok(rows.some((row) => row.includes('ab restores: line one of the crash draft… (+1 line)')));
    assert.ok(!rows.some((row) => row.includes('\\u000a')), 'line breaks are not drawn as escapes');
    assert.equal(env.editor.getText(), '');
    env.editor.handleInput('\t');
    await started.session.settle();
    assert.equal(env.editor.getText(), text);
  } finally {
    await started.dispose();
  }
});

test('a sent typed prompt is recorded in history, filed under its folder outside a repository', async () => {
  // Pi clears the editor before its `input` event confirms the send, and the
  // confirmation took the typed spans from the now-empty draft, so history
  // and phrases never learned a prompt. Outside a repository every folder's
  // prompts were filed under one all-zero project, which
  // `murmo history list/wipe --project <dir>` never matches.
  const folder = join(root, 'loose-folder');
  mkdirSync(folder, { recursive: true });
  mkdirSync(join(process.env.XDG_CONFIG_HOME as string, 'murmo'), { recursive: true });
  writeFileSync(
    join(process.env.XDG_CONFIG_HOME as string, 'murmo', 'murmo.toml'),
    'version = 1\n[history]\nenabled = true\n',
  );
  const env = createFakePi();
  const started = await startPiSession({
    Base: FakePiEditor,
    tuiApi: fakeTuiApi,
    ctx: env.ctx,
    pi: env.host,
    version: '1.3.0',
    cwd: folder,
  });
  try {
    for (const ch of 'remember this prompt') env.editor.handleInput(ch);
    await started.session.settle();
    env.editor.handleInput('\r');
    for (let i = 0; i < 200 && env.editor.submitCount === 0; i++) await new Promise((r) => setImmediate(r));
    // Pi's own `input` event confirms the send.
    env.host.emit('input', { source: 'interactive', text: 'remember this prompt' });
    await started.session.settle();
  } finally {
    await started.dispose();
  }
  const store = await openStore({ roots: storeRootsFromEnv() });
  const records = await loadRecords(store);
  assert.deepEqual(
    records.map((record) => record.text),
    ['remember this prompt'],
  );
  assert.deepEqual(
    records.flatMap((record) => record.events.map((event) => event.project)),
    [await projectIdOfCwd(folder)],
  );
});

test('a collapsed Pi paste is reported as a folded part of the draft', async () => {
  // Pi shows a big paste as `[paste #1 +40 lines]`; restoring that label would
  // not bring the paste back, so the draft must say it folds a part.
  const { env, started } = await start();
  try {
    const big = Array.from({ length: 41 }, (_, i) => `line ${i}`).join('\n');
    for (const ch of 'see ') env.editor.handleInput(ch);
    env.editor.handleInput(`\x1b[200~${big}\x1b[201~`);
    await started.session.settle();
    const draft = started.adapter.getDraft();
    assert.equal(draft.text, 'see [paste #1 +40 lines]');
    assert.deepEqual(draft.foldedParts, [[4, draft.text.length]]);
  } finally {
    await started.dispose();
  }
});

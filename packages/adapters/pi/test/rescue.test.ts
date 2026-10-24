// Draft rescue through the real Pi wiring (startPiSession) on the fake Pi:
// the store is the file store under a throwaway XDG state folder.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
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

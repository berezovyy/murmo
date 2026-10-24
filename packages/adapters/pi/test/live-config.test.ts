// Config edits and `murmo trust` apply to a running Pi session: before, Pi read
// murmo.toml once at session start, so a new shortcut stayed literal and an
// approved project file stayed off until the agent restarted.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { approveProject, scanProject } from '@murmo/config/node';
import { openStore, storeRootsFromEnv } from '@murmo/store/node';
import { startPiSession } from '../src/session.ts';
import { createFakePi, FakePiEditor, fakeTuiApi } from './fake-pi.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'murmo-pi-live-')));
after(() => rmSync(dir, { recursive: true, force: true }));
const home = join(dir, 'home');
const userFile = join(home, '.config', 'murmo', 'murmo.toml');
mkdirSync(join(home, '.config', 'murmo'), { recursive: true });
Object.assign(process.env, {
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, 'data'),
  XDG_STATE_HOME: join(home, 'state'),
  XDG_CACHE_HOME: join(home, 'cache'),
});

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let waited = 0; waited < 3000; waited += 10) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('a shortcut added to murmo.toml and an approved project file apply without a restart', async () => {
  writeFileSync(userFile, `version = 1\n[replace]\n";me" = 'personal shortcut'\n`);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.murmo.toml'), `version = 1\n[replace]\n";hp" = 'project shortcut'\n`);
  const env = createFakePi();
  const started = await startPiSession({
    Base: FakePiEditor,
    tuiApi: fakeTuiApi,
    ctx: env.ctx,
    pi: env.host,
    version: '1.3.0',
    cwd: repo,
    recheckMs: 10,
  });
  const type = (text: string) => {
    for (const ch of text) env.editor.handleInput(ch);
  };
  const screen = () => env.editor.render(200).join('\n');
  try {
    assert.match(screen(), /\.murmo\.toml has 1 shortcut\. Run "murmo trust" to review\./);
    type(';hp ');
    assert.equal(started.adapter.getDraft().text, ';hp ', 'unreviewed: literal');

    writeFileSync(userFile, `version = 1\n[replace]\n";me" = 'personal shortcut'\n";new" = 'added live'\n`);
    await until('the new shortcut count', () => screen().includes('murmo on · 2 shortcuts'));
    type(';new ');
    assert.equal(started.adapter.getDraft().text, ';hp added live ');

    const store = await openStore({ roots: storeRootsFromEnv() });
    const snapshot = await scanProject(repo);
    assert.equal((await approveProject(store, repo, snapshot?.fingerprint ?? '')).status, 'ok');
    await until('the trust notice to go', () => !screen().includes('murmo trust'));
    type(';hp ');
    assert.equal(started.adapter.getDraft().text, ';hp added live project shortcut ');
    assert.match(screen(), /murmo on · 3 shortcuts/);
  } finally {
    await started.dispose();
  }
});

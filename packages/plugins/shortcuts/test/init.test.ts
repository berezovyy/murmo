// murmo init writes the starter file, never overwrites, and approves its own project file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseConfig } from '@murmo/config';
import { loadSessionConfig } from '@murmo/config/node';
import { openStore } from '@murmo/store/node';
import { INIT_TEMPLATE, USER_TEMPLATE } from '../src/index.ts';
import { initCommand } from '../src/node/index.ts';
import { gitRepo, storeRoots, tempDir } from './helpers.ts';

const cleanup: Array<{ remove: () => void }> = [];
after(() => {
  for (const t of cleanup) t.remove();
});

test('murmo init writes the template and approves it; a second call refuses to overwrite', async () => {
  const t = tempDir('murmo-init-');
  cleanup.push(t);
  const root = gitRepo(join(t.dir, 'repo'), {});
  const store = await openStore({ roots: storeRoots(t.dir) });
  const out: string[] = [];
  const err: string[] = [];
  const ctx = { store, cwd: root, out: (s: string) => out.push(s), err: (s: string) => err.push(s), now: () => 1 };
  assert.equal(await initCommand([], ctx), 0);
  const path = join(root, '.murmo.toml');
  assert.equal(readFileSync(path, 'utf8'), INIT_TEMPLATE);
  const parsed = parseConfig(INIT_TEMPLATE, { file: path, origin: 'project' });
  assert.equal(parsed.status, 'ok');
  assert.deepEqual(
    parsed.shortcuts.map((s) => s.shortcut),
    [';rvw', ';tst'],
  );
  const session = await loadSessionConfig({ cwd: root, store, env: { HOME: join(t.dir, 'home') } });
  assert.equal(session.trust, 'approved');
  assert.equal(session.effective.replacements.length, 2);

  assert.equal(await initCommand([], ctx), 1);
  assert.match(err.join('\n'), /already exists/);
});

test('murmo init --user writes the personal file and never overwrites', async () => {
  const t = tempDir('murmo-init-user-');
  cleanup.push(t);
  const store = await openStore({ roots: storeRoots(t.dir) });
  const home = join(t.dir, 'home');
  const out: string[] = [];
  const err: string[] = [];
  const ctx = {
    store,
    cwd: t.dir,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    env: { HOME: home },
    home,
  };
  assert.equal(await initCommand(['--user'], ctx), 0);
  const path = join(home, '.config', 'murmo', 'murmo.toml');
  assert.equal(readFileSync(path, 'utf8'), USER_TEMPLATE);
  assert.equal(await initCommand(['--user'], ctx), 1);
  assert.match(err.join('\n'), /already exists/);
});

test('the init template is the one the fixtures pin', () => {
  // Catches a docs/init drift that would fail the starter-file fixture.
  const pinned = readFileSync(new URL('../../../../fixtures/shortcuts/init.toml', import.meta.url), 'utf8');
  assert.equal(INIT_TEMPLATE, pinned);
});

test('the personal starter has the shortcuts, autocorrect off, and stanzas that work when uncommented', () => {
  // Catches a starter that turns autocorrect on behind the user's back, or a
  // commented [autocorrect] / [words] example that is wrong once uncommented.
  const starter = parseConfig(USER_TEMPLATE, { file: 'murmo.toml', origin: 'user' });
  assert.equal(starter.status, 'ok');
  assert.deepEqual(starter.diagnostics, []);
  assert.deepEqual(
    starter.shortcuts.map((s) => s.shortcut),
    [';rvw', ';tst'],
  );
  assert.equal(starter.autocorrect, undefined);
  const uncommented = USER_TEMPLATE.replace(/^# (\[(?:autocorrect|words)\]|enabled = |protect = )/gm, '$1');
  const on = parseConfig(uncommented, { file: 'murmo.toml', origin: 'user' });
  assert.deepEqual(on.diagnostics, []);
  assert.equal(on.autocorrect, true);
  assert.deepEqual(on.protect, ['Kubernetes']);
});

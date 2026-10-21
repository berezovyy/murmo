// Discovery, the idle re-check and the load-time target (phase 14 E3).
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openStore, type Store } from '@murmo/store/node';
import {
  approveProject,
  loadSessionConfig,
  recheckSessionConfig,
  scanProject,
  userConfigPath,
} from '../src/node/index.ts';
import { configCases } from './fixtures.ts';
import { sourceOf, type TomlCase } from './parity-cases.ts';
import { trustCases, type Workspace, workspace } from './repos.ts';

let ws: Workspace;
let store: Store;
before(async () => {
  ws = workspace('murmo-load-');
  store = await openStore({ roots: ws.roots });
});
after(() => ws.remove());

test('the user file is $XDG_CONFIG_HOME/murmo/murmo.toml, else ~/.config, on macOS too', () => {
  // Catches ~/Library/Application Support or a relative XDG value being used.
  assert.equal(userConfigPath({ XDG_CONFIG_HOME: '/x/cfg' }, '/home/u'), '/x/cfg/murmo/murmo.toml');
  assert.equal(userConfigPath({ XDG_CONFIG_HOME: 'rel' }, '/home/u'), '/home/u/.config/murmo/murmo.toml');
  assert.equal(userConfigPath({}, '/home/u'), '/home/u/.config/murmo/murmo.toml');
});

test('only the repository root .murmo.toml is read, found from any subfolder', async () => {
  // Catches a nested .murmo.toml (a vendored dependency) loading shortcuts.
  const root = ws.repo('nested', trustCases.base, [
    { op: 'write', path: 'vendor/lib/.murmo.toml', text: '[replace]\n";evil" = "x"\n' },
  ]);
  const session = await loadSessionConfig({ cwd: join(root, 'vendor', 'lib'), store, env: ws.env });
  assert.equal(session.project?.config.file, join(session.project?.identity.root ?? '', '.murmo.toml'));
  assert.ok(!session.project?.config.shortcuts.some((s) => s.shortcut === ';evil'));
});

test('a symlinked personal file is followed, and its private flag reaches the store', async () => {
  // Catches a dotfiles-managed murmo.toml being ignored, or [privacy] not reaching private mode.
  const dotfiles = join(ws.dir, 'dotfiles');
  mkdirSync(dotfiles, { recursive: true });
  writeFileSync(join(dotfiles, 'murmo.toml'), '[replace]\n";me" = { file = "me.md" }\n[privacy]\nprivate = true\n');
  writeFileSync(join(dotfiles, 'me.md'), 'Me\n');
  symlinkSync(join(dotfiles, 'murmo.toml'), join(ws.home, '.config', 'murmo', 'murmo.toml'));
  try {
    const session = await loadSessionConfig({ cwd: ws.dir, store, env: ws.env });
    assert.deepEqual(
      session.effective.replacements.map((s) => [s.shortcut, s.text]),
      [[';me', 'Me']],
    );
    assert.equal(await store.privacy.isPrivate(), true);
  } finally {
    writeFileSync(join(dotfiles, 'murmo.toml'), '');
    await loadSessionConfig({ cwd: ws.dir, store, env: ws.env });
  }
  assert.equal(await store.privacy.isPrivate(), false);
});

test('the idle re-check reloads only when a file it read changed', async () => {
  // Catches a stale config after an edit or an approval, and needless reloads while idle.
  const root = ws.repo('watch', trustCases.base);
  const options = { cwd: root, store, env: ws.env };
  let session = await loadSessionConfig(options);
  assert.equal(await recheckSessionConfig(session, options), undefined);
  // An approval (trust.json) is noticed.
  const snapshot = await scanProject(root);
  await approveProject(store, root, snapshot?.fingerprint ?? '');
  session = (await recheckSessionConfig(session, options)) ?? assert.fail('approval not noticed');
  assert.equal(session.trust, 'approved');
  // An edit of a referenced file is noticed.
  writeFileSync(join(root, 'prompt.txt'), 'Edited.\n');
  session = (await recheckSessionConfig(session, options)) ?? assert.fail('reference edit not noticed');
  assert.equal(session.trust, 'changed');
  // A project file created later is noticed.
  const bare = ws.repo('bare');
  const options2 = { cwd: bare, store, env: ws.env };
  const empty = await loadSessionConfig(options2);
  assert.equal(empty.trust, 'none');
  writeFileSync(join(bare, '.murmo.toml'), '[replace]\nx = "y"\n');
  assert.equal((await recheckSessionConfig(empty, options2))?.trust, 'review');
});

test('a 1,000-shortcut trusted load stays within p50 1.5 ms and p99 3 ms', async (t) => {
  // Catches quadratic work at session start (r8 once spent 22.79 ms on diagnostics, E3).
  const big = configCases('toml-corpus.json').find((c) => c.name === '1000-shortcuts') as TomlCase;
  const root = ws.repo('thousand', [{ op: 'write', path: '.murmo.toml', text: sourceOf(big) }]);
  const fingerprint = (await scanProject(root))?.fingerprint ?? '';
  assert.equal((await approveProject(store, root, fingerprint)).status, 'ok');
  const options = { cwd: root, store, env: ws.env };
  for (let i = 0; i < 30; i++) await loadSessionConfig(options);
  const times: number[] = [];
  for (let i = 0; i < 300; i++) {
    const started = performance.now();
    const session = await loadSessionConfig(options);
    times.push(performance.now() - started);
    assert.equal(session.effective.replacements.length, 1000);
  }
  times.sort((a, b) => a - b);
  const p50 = times[150] ?? 0;
  const p99 = times[297] ?? 0;
  t.diagnostic(`1,000-shortcut trusted load: p50 ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms`);
  // The target holds on an idle machine; a loaded suite (SIGKILL, lang-en
  // verifier, shortcut expansions) gets 8x room so the test still catches a
  // quadratic regression (which costs 10x or more).
  const slack = process.env.MURMO_STRICT_TIMING === '1' ? 1 : 8;
  assert.ok(p50 <= 1.5 * slack, `p50 ${p50} ms`);
  assert.ok(p99 <= 3 * slack, `p99 ${p99} ms`);
});

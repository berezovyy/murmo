// Built-in plugins on the adapter: literal shortcuts from settings (r14 H1)
// and a packed test table for `teh `.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EffectiveConfig } from '@murmo/config';
import { testInlinePlugin } from '@murmo/core/testing';
import { createInProcessExecutor } from '@murmo/executor';
import { loadEnglishPack } from '@murmo/plugin-autocorrect/node';
import { compileShortcuts, shortcutsPlugin } from '@murmo/plugin-shortcuts';
import { OpenCodeAdapter } from '../src/adapter.ts';
import { loadHostSessionConfig, startSession } from '../src/session.ts';
import { FakeOpenCode } from './fake-opencode.ts';

function cfg(autocorrect: boolean): EffectiveConfig {
  return {
    replacements: [],
    overrides: [],
    protect: [],
    autocorrect,
    phrasesLearn: false,
    historyEnabled: false,
    plugins: {},
    private: false,
    events: false,
    eventsFailOpen: false,
    diagnostics: [],
  };
}

const executor = () => createInProcessExecutor({ pressure: () => 1 });

test(';tst space expands from installed shortcut settings (r14 H1)', async () => {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  const compiled = compileShortcuts({
    replacements: [{ shortcut: ';tst', text: 'Run the test suite.', origin: 'user' }],
  });
  const started = await startSession({
    adapter,
    loadLanguagePack: false,
    executor: executor(),
    plugins: [shortcutsPlugin(compiled)],
  });
  host.type(';tst');
  host.press({ name: 'space', sequence: ' ' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(adapter.getDraft().text, 'Run the test suite. ');
  await started.close();
});

test('typed teh plus space becomes the  (test table, burst path)', async () => {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  const started = await startSession({
    adapter,
    loadLanguagePack: false,
    executor: executor(),
    plugins: [testInlinePlugin('autocorrect', { enabled: true })],
  });
  host.type('teh');
  host.press({ name: 'space', sequence: ' ' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(adapter.getDraft().text, 'the ');
  await started.close();
});

test('tui builtins without user config leave teh (the packed OpenCode miss)', async () => {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  const started = await startSession({ adapter, executor: executor() });
  host.type('teh');
  host.press({ name: 'space', sequence: ' ' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(adapter.getDraft().text, 'teh ');
  await started.close();
});

test('user autocorrect on plus shipped english.bin corrects typed teh, not paste', async () => {
  const root = mkdtempSync(join(tmpdir(), 'murmo-oc-pack-'));
  const prev = process.env.MURMO_PACKAGE_ROOT;
  try {
    mkdirSync(join(root, 'data', 'en'), { recursive: true });
    writeFileSync(join(root, 'data', 'en', 'english.bin'), loadEnglishPack().bytes);
    process.env.MURMO_PACKAGE_ROOT = root;
    const host = new FakeOpenCode();
    const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
    const started = await startSession({ adapter, executor: executor(), config: cfg(true) });
    host.type('teh');
    host.press({ name: 'space', sequence: ' ' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(adapter.getDraft().text, 'the ');
    host.prompt.replaceText('');
    host.paste('teh ');
    await Promise.resolve();
    assert.match(adapter.getDraft().text, /teh/);
    await started.close();
  } finally {
    if (prev === undefined) delete process.env.MURMO_PACKAGE_ROOT;
    else process.env.MURMO_PACKAGE_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadHostSessionConfig turns autocorrect on from the user file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'murmo-oc-cfg-'));
  try {
    const home = join(dir, 'home');
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      XDG_CACHE_HOME: join(home, '.cache'),
    };
    mkdirSync(join(env.XDG_CONFIG_HOME as string, 'murmo'), { recursive: true });
    writeFileSync(join(env.XDG_CONFIG_HOME as string, 'murmo', 'murmo.toml'), '[autocorrect]\nenabled = true\n');
    const cwd = join(dir, 'proj');
    mkdirSync(cwd);
    const effective = await loadHostSessionConfig(cwd, env);
    assert.equal(effective.autocorrect, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
import { openStore, storeRootsFromEnv } from '@murmo/store/node';
import { OpenCodeAdapter } from '../src/adapter.ts';
import { hostSessionOptions, loadHostSession, startSession } from '../src/session.ts';
import { createStatusSurface } from '../src/status.ts';
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

test('loadHostSession turns autocorrect on from the user file', async () => {
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
    const { effective } = await loadHostSession(cwd, env);
    assert.equal(effective.autocorrect, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a template shortcut from config inserts its field defaults (real-host bug)', async () => {
  // OpenCode inserted `Review <change> for correctness.`: the session copied
  // only shortcut, text and origin into the compiler and dropped `fields`.
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  const started = await startSession({
    adapter,
    loadLanguagePack: false,
    executor: executor(),
    config: {
      ...cfg(false),
      replacements: [
        {
          shortcut: ';review',
          text: 'Review <change> for correctness.',
          origin: 'user',
          fields: { change: { default: 'this change' } },
        },
      ],
    },
  });
  host.type(';review');
  host.press({ name: 'space', sequence: ' ' });
  await Promise.resolve();
  await Promise.resolve();
  assert.match(adapter.getDraft().text, /^Review this change for correctness\./);
  await started.close();
});

test('a word added with murmo words is left alone in the next session', async () => {
  // `murmo words add teh` printed "Added teh." yet teh still became the:
  // no host read the stored list into autocorrect's protection.
  const dir = mkdtempSync(join(tmpdir(), 'murmo-oc-words-'));
  const prev = process.env.MURMO_PACKAGE_ROOT;
  try {
    const root = join(dir, 'package');
    mkdirSync(join(root, 'data', 'en'), { recursive: true });
    writeFileSync(join(root, 'data', 'en', 'english.bin'), loadEnglishPack().bytes);
    process.env.MURMO_PACKAGE_ROOT = root;
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
    const store = await openStore({ roots: storeRootsFromEnv(env) });
    assert.equal((await store.words.add('teh', { learned: false })).status, 'ok');
    const cwd = join(dir, 'proj');
    mkdirSync(cwd);
    const host = new FakeOpenCode();
    const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
    const started = await startSession({
      adapter,
      executor: executor(),
      config: (await loadHostSession(cwd, env)).effective,
    });
    host.type('teh');
    host.press({ name: 'space', sequence: ' ' });
    host.type('adn');
    host.press({ name: 'space', sequence: ' ' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(adapter.getDraft().text, 'teh and ');
    await started.close();
  } finally {
    if (prev === undefined) delete process.env.MURMO_PACKAGE_ROOT;
    else process.env.MURMO_PACKAGE_ROOT = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shortcut with a non-ASCII name expands when typed (real-host bug)', async () => {
  // `;привіт` plus space stayed literal on OpenCode while Pi and Claude
  // expanded it: Cyrillic keys were not counted as typed, so no fully typed
  // span covered the name. The ASCII control shows the session is live.
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  const compiled = compileShortcuts({
    replacements: [
      { shortcut: ';привіт', text: 'Привіт! 👋', origin: 'user' },
      { shortcut: ';hi', text: 'Hello!', origin: 'user' },
    ],
  });
  const started = await startSession({
    adapter,
    loadLanguagePack: false,
    executor: executor(),
    plugins: [shortcutsPlugin(compiled)],
  });
  host.type(';hi ;привіт ');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(adapter.getDraft().text, 'Hello! Привіт! 👋 ');
  await started.close();
});

function homeEnv(dir: string): NodeJS.ProcessEnv {
  const home = join(dir, 'home');
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
  };
}

async function footerOf(options: Omit<Parameters<typeof startSession>[0], 'adapter'>) {
  const host = new FakeOpenCode();
  const status = createStatusSurface(host.api);
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core, status });
  const started = await startSession({ adapter, loadLanguagePack: false, executor: executor(), ...options });
  return { host, status, started };
}

test('the footer says murmo is on and that an unreviewed project file needs murmo trust (real-host bug)', async () => {
  // OpenCode never showed a Murmo line: every status waited for dialog
  // safety, and the session passed no trust state, so an unreviewed
  // .murmo.toml left ;team literal with nothing saying why.
  const dir = mkdtempSync(join(tmpdir(), 'murmo-oc-trust-'));
  try {
    const env = homeEnv(dir);
    mkdirSync(join(env.XDG_CONFIG_HOME as string, 'murmo'), { recursive: true });
    writeFileSync(
      join(env.XDG_CONFIG_HOME as string, 'murmo', 'murmo.toml'),
      'version = 1\n[replace]\n";hi" = \'Hello\'\n',
    );
    const cwd = join(dir, 'proj');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    writeFileSync(join(cwd, '.murmo.toml'), 'version = 1\n[replace]\n";team" = \'Team text\'\n');
    const { status, started } = await footerOf(await hostSessionOptions(() => loadHostSession(cwd, env)));
    assert.equal(
      status.get(),
      '.murmo.toml has 1 shortcut. Run "murmo trust" to review. | murmo on · 1 shortcut · autocorrect off',
    );
    await started.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken personal murmo.toml is named with its line in the footer (real-host bug)', async () => {
  // `[shortcuts] hi = "hello"` loaded nothing and said nothing on any host.
  const dir = mkdtempSync(join(tmpdir(), 'murmo-oc-broken-'));
  try {
    const env = homeEnv(dir);
    mkdirSync(join(env.XDG_CONFIG_HOME as string, 'murmo'), { recursive: true });
    writeFileSync(
      join(env.XDG_CONFIG_HOME as string, 'murmo', 'murmo.toml'),
      'version = 1\n[shortcuts]\nhi = "hello"\n',
    );
    const cwd = join(dir, 'proj');
    mkdirSync(cwd);
    const { status, started } = await footerOf(await hostSessionOptions(() => loadHostSession(cwd, env)));
    assert.equal(
      status.get(),
      'murmo.toml:2: unknown key "shortcuts" ignored | murmo on · no shortcuts · autocorrect off',
    );
    await started.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a config that fails to load says so in the footer instead of failing silently (real-host bug)', async () => {
  // On OpenCode 2.0.32 the load threw inside setup, the error was swallowed,
  // and shortcuts stayed literal while doctor said all was fine.
  const { status, started } = await footerOf(
    await hostSessionOptions(() => Promise.reject(new Error('lstat is not a function'))),
  );
  assert.match(
    status.get(),
    /^Murmo could not load murmo\.toml \(lstat is not a function\); shortcuts are off this session\./,
  );
  await started.close();
});

test('a project shortcut that overrides a personal one is said in the footer', async () => {
  // OpenCode never said a project ;rvw replaced the personal one.
  const { status, started } = await footerOf({
    config: {
      ...cfg(false),
      replacements: [{ shortcut: ';rvw', text: 'Project review.', origin: 'project' }],
      overrides: [';rvw'],
    },
  });
  assert.match(status.get(), /Project shortcut ;rvw overrides your personal one\./);
  await started.close();
});

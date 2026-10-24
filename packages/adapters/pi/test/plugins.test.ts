// Installed loader registers literal shortcut settings as inline rules
// (r14 H1: `;r14␠` stayed literal because the loader never did this).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { EffectiveConfig } from '@murmo/config';
import { loadEnglishPack } from '@murmo/plugin-autocorrect/node';
import { importPiPackage } from '../src/index.ts';
import { loadBuiltins } from '../src/plugins.ts';
import { startLive } from './helpers.ts';

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

test('importPiPackage resolves host packages from Pi cli.js (packed -e path)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'murmo-pi-resolve-'));
  try {
    const cli = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'cli.js');
    const pkg = join(root, 'node_modules', '@earendil-works', 'pi-tui', 'index.js');
    mkdirSync(dirname(cli), { recursive: true });
    mkdirSync(dirname(pkg), { recursive: true });
    writeFileSync(join(dirname(cli), 'package.json'), '{"name":"@earendil-works/pi-coding-agent","type":"module"}\n');
    writeFileSync(
      join(dirname(pkg), 'package.json'),
      '{"name":"@earendil-works/pi-tui","type":"module","exports":"./index.js"}\n',
    );
    writeFileSync(cli, 'export const VERSION = "test";\n');
    writeFileSync(pkg, 'export const CURSOR_MARKER = "x";\n');
    const tui = await importPiPackage('@earendil-works/pi-tui', cli);
    assert.equal(tui.CURSOR_MARKER, 'x');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadBuiltins registers shortcut literals as inline replacements (E18)', () => {
  const loaded = loadBuiltins({
    ids: ['shortcuts', 'menu', 'names'],
    config: {
      language: 'en',
      replacements: [{ shortcut: 'r14', text: 'round fourteen', origin: 'user' }],
      overrides: [],
      protect: [],
      autocorrect: false,
      phrasesLearn: false,
      historyEnabled: false,
      plugins: {},
      private: false,
      events: false,
      eventsFailOpen: false,
      diagnostics: [],
    },
  });
  const shortcuts = loaded.specs.find((spec) => spec.id === 'shortcuts');
  assert.ok(shortcuts?.inline?.length, 'shortcuts spec must carry inline rules');
  const entries = shortcuts?.inline?.[0]?.replacements?.entries ?? {};
  assert.equal(entries.r14, 'round fourteen');
  const semi = loadBuiltins({
    ids: ['shortcuts'],
    config: {
      replacements: [{ shortcut: ';r14', text: 'round fourteen', origin: 'user' }],
      overrides: [],
      protect: [],
      autocorrect: false,
      phrasesLearn: false,
      historyEnabled: false,
      plugins: {},
      private: false,
      events: false,
      eventsFailOpen: false,
      diagnostics: [],
    },
  });
  assert.equal(semi.specs[0]?.inline?.[0]?.replacements?.entries?.[';r14'], 'round fourteen');
  assert.deepEqual(loaded.order, ['shortcuts', 'menu', 'names']);
});

test('default builtins include the names plugin so Tab can open project names (phase 36)', () => {
  const loaded = loadBuiltins();
  assert.ok(loaded.specs.some((spec) => spec.id === 'names'));
  assert.ok(loaded.order.includes('names'));
});

test('explicit pluginOrder AB/BA is honored when it names every spec (E20)', () => {
  const ba = loadBuiltins({
    ids: ['shortcuts', 'menu'],
    config: {
      replacements: [],
      overrides: [],
      protect: [],
      autocorrect: false,
      phrasesLearn: false,
      historyEnabled: false,
      pluginOrder: ['menu', 'shortcuts'],
      plugins: {},
      private: false,
      events: false,
      eventsFailOpen: false,
      diagnostics: [],
    },
  });
  assert.deepEqual(ba.order, ['menu', 'shortcuts']);
});

test('user autocorrect on plus shipped english.bin corrects typed teh (packed product path)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'murmo-pi-pack-'));
  const prev = process.env.MURMO_PACKAGE_ROOT;
  try {
    mkdirSync(join(root, 'data', 'en'), { recursive: true });
    writeFileSync(join(root, 'data', 'en', 'english.bin'), loadEnglishPack().bytes);
    process.env.MURMO_PACKAGE_ROOT = root;
    const loaded = loadBuiltins({ ids: ['autocorrect'], config: cfg(true) });
    assert.equal(loaded.specs[0]?.inline?.[0]?.enabled, true);
    const live = await startLive(loaded.specs);
    live.type('teh ');
    await live.session.settle();
    assert.equal(live.adapter.getDraft().text, 'the ');
    await live.dispose();
  } finally {
    if (prev === undefined) delete process.env.MURMO_PACKAGE_ROOT;
    else process.env.MURMO_PACKAGE_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('shipped pack with autocorrect off leaves teh (opt-in; packed miss without user file)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'murmo-pi-off-'));
  const prev = process.env.MURMO_PACKAGE_ROOT;
  try {
    mkdirSync(join(root, 'data', 'en'), { recursive: true });
    writeFileSync(join(root, 'data', 'en', 'english.bin'), loadEnglishPack().bytes);
    process.env.MURMO_PACKAGE_ROOT = root;
    const loaded = loadBuiltins({ ids: ['autocorrect'], config: cfg(false) });
    assert.equal(loaded.specs[0]?.inline?.[0]?.enabled, false);
    const live = await startLive(loaded.specs);
    live.type('teh ');
    await live.session.settle();
    assert.equal(live.adapter.getDraft().text, 'teh ');
    await live.dispose();
  } finally {
    if (prev === undefined) delete process.env.MURMO_PACKAGE_ROOT;
    else process.env.MURMO_PACKAGE_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a template shortcut inserts its field defaults, not the bare placeholder (real-host bug)', () => {
  // Pi inserted `Review <change> for correctness.` from the starter template:
  // the loader copied only shortcut, text and origin and dropped `fields`.
  const loaded = loadBuiltins({
    ids: ['shortcuts'],
    config: {
      ...cfg(false),
      replacements: [
        {
          shortcut: ';review',
          text: 'Review <change> for correctness.',
          origin: 'user',
          description: 'Code review request',
          fields: { change: { default: 'this change' } },
        },
      ],
    },
  });
  const entries = loaded.specs.find((spec) => spec.id === 'shortcuts')?.inline?.[0]?.replacements?.entries ?? {};
  assert.equal(entries[';review'], 'Review this change for correctness.');
});

test('startup notices carry the real trust state and the file that turned autocorrect off (real-host bug)', () => {
  // Pi passed no trust state, so an unreviewed .murmo.toml never got its
  // "murmo trust" notice; and after a project turned autocorrect off, Pi told
  // a user whose personal file already turns it on to "opt in".
  const loaded = loadBuiltins({
    ids: ['shortcuts'],
    config: cfg(false),
    session: { trust: 'review', project: { file: '/repo/.murmo.toml', shortcuts: 2, autocorrect: false } },
  });
  assert.deepEqual(loaded.notices, [
    '.murmo.toml has 2 shortcuts. Run "murmo trust" to review.',
    'murmo on · no shortcuts · autocorrect off in .murmo.toml',
  ]);
});

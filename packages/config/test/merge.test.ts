// Merge: defaults < user file < project file, the override report and the
// "can only do less" rule; plugin settings without host-owned keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type PluginManifest, parseManifest } from '@murmo/api';
import {
  type ConfigOrigin,
  HOST_OWNED_PLUGIN_KEYS,
  type LoadedConfig,
  mergeConfig,
  parseConfig,
  pluginSettings,
  resolveShortcuts,
} from '../src/index.ts';

const load = (text: string, origin: ConfigOrigin): LoadedConfig =>
  resolveShortcuts(parseConfig(text, { file: origin === 'user' ? 'murmo.toml' : '.murmo.toml', origin }), new Map());

const user = load(
  [
    'language = "en"',
    '[replace]',
    '";a" = "user a"',
    '";b" = "user b"',
    '[words]',
    'protect = ["ratatui"]',
    '[autocorrect]',
    'enabled = true',
    '[plugins]',
    'order = ["menu", "rescue"]',
    '[plugins.rescue]',
    'enabled = true',
    'idle = 1500',
    'mode = "user"',
  ].join('\n'),
  'user',
);
const project = load(
  [
    'language = "de"',
    '[replace]',
    '";b" = "project b"',
    '";c" = "project c"',
    '[words]',
    'protect = ["OutboxWorker", "ratatui"]',
    '[autocorrect]',
    'enabled = false',
    '[plugins.rescue]',
    'enabled = false',
    'idle = 10',
    '[plugins.menu]',
    'rows = 3',
  ].join('\n'),
  'project',
);

test('a trusted project file overrides personal shortcuts and lists each override', () => {
  // Catches a silent override: the user would not know why ;b changed (02-architecture).
  const merged = mergeConfig({ user, project, projectTrusted: true });
  assert.deepEqual(
    merged.replacements.map((s) => [s.shortcut, s.text, s.origin]),
    [
      [';a', 'user a', 'user'],
      [';b', 'project b', 'project'],
      [';c', 'project c', 'project'],
    ],
  );
  assert.deepEqual(merged.overrides, [';b']);
  const notice = merged.diagnostics.find((d) => d.code === 'override');
  assert.deepEqual(
    [notice?.file, notice?.line, notice?.message],
    ['.murmo.toml', 3, 'project shortcut ";b" overrides your personal one'],
  );
  assert.deepEqual(merged.plugins.rescue, { enabled: false, settings: { idle: 10, mode: 'user' } });
  assert.deepEqual(merged.plugins.menu, { settings: { rows: 3 } });
  assert.equal(merged.language, 'de');
});

test('an untrusted project file still turns things off, never on', () => {
  // Catches a hostile clone loading shortcuts or plugin settings, and a review
  // gate that also blocks the user's own "off" switches in the repository.
  const merged = mergeConfig({ user, project, projectTrusted: false });
  assert.deepEqual(
    merged.replacements.map((s) => s.shortcut),
    [';a', ';b'],
  );
  assert.deepEqual(merged.overrides, []);
  assert.equal(merged.autocorrect, false, 'autocorrect = false applies untrusted');
  assert.equal(merged.phrasesLearn, false, 'phrase learning stays off until the user file turns it on');
  assert.deepEqual(merged.protect, ['ratatui', 'OutboxWorker'], 'protected words apply untrusted');
  assert.equal(merged.language, 'de', 'language applies untrusted');
  assert.deepEqual(merged.plugins.rescue, { enabled: false, settings: { idle: 1500, mode: 'user' } });
  assert.deepEqual(merged.plugins.menu, { settings: {} });
  assert.deepEqual(merged.pluginOrder, ['menu', 'rescue']);
  const notices = merged.diagnostics.filter((d) => d.code === 'untrusted');
  assert.deepEqual(
    notices.map((d) => d.message),
    ['2 shortcuts and settings for 2 plugins stay off until you review this file: run "murmo trust"'],
  );
});

test('defaults: autocorrect off, not private, and private from either file', () => {
  // Catches opt-in autocorrect turning on by default, or a project unable to ask for privacy.
  const empty = mergeConfig({ projectTrusted: false });
  assert.equal(empty.autocorrect, false);
  assert.equal(empty.private, false);
  assert.equal(mergeConfig({ user, projectTrusted: false }).autocorrect, true);
  const privateProject = load('[privacy]\nprivate = true\n', 'project');
  assert.equal(mergeConfig({ user, project: privateProject, projectTrusted: false }).private, true);
});

test('an ignored file contributes its diagnostic and nothing else', () => {
  // Fail open per file: catches a broken project file hiding the user's shortcuts.
  const broken = load('[replace\n', 'project');
  const merged = mergeConfig({ user, project: broken, projectTrusted: true });
  assert.deepEqual(
    merged.replacements.map((s) => s.shortcut),
    [';a', ';b'],
  );
  assert.deepEqual(
    merged.diagnostics.map((d) => [d.file, d.code]),
    [['.murmo.toml', 'parse']],
  );
});

const manifest: PluginManifest = parseManifest(
  JSON.stringify({
    name: 'rescue',
    version: '1.0.0',
    api: '^2.0.0',
    entry: 'plugin.mjs',
    permissions: [],
    capabilities: { required: {}, optional: {} },
    settingsSchema: {
      type: 'object',
      properties: {
        idle: { type: 'integer', default: 2000 },
        mode: { type: 'string', enum: ['user', 'off'] },
      },
      additionalProperties: false,
    },
  }),
);

test('host-owned keys are stripped before resolveSettings', () => {
  // Phase 03 hand-off: catches `enabled` reaching the plugin, where a schema
  // without it (additionalProperties: false) would refuse every config.
  assert.deepEqual(HOST_OWNED_PLUGIN_KEYS, ['enabled']);
  const merged = mergeConfig({ user, project, projectTrusted: true });
  assert.deepEqual(pluginSettings(merged, 'rescue', manifest), { status: 'ok', settings: { idle: 10, mode: 'user' } });
  // Defaults apply for a plugin the config never mentions.
  assert.deepEqual(pluginSettings(mergeConfig({ projectTrusted: false }), 'rescue', manifest), {
    status: 'ok',
    settings: { idle: 2000 },
  });
  // A bad setting fails that plugin closed, naming the setting.
  const bad = mergeConfig({ user: load('[plugins.rescue]\nmode = "loud"\n', 'user'), projectTrusted: false });
  const result = pluginSettings(bad, 'rescue', manifest);
  assert.equal(result.status, 'invalid');
  assert.equal(result.status === 'invalid' && result.path, 'settings.mode');
});

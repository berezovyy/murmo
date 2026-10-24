// Expansion through the core inline path (lesson 26, E1): byte-exact, Backspace
// revert, size boundary, no recursion, all four host capability profiles.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { type PluginHost, registerRuleSet, reloadPlugins } from '@murmo/core';
import { createHarness } from '@murmo/core/testing';
import { utf8Length } from '@murmo/text';
import { compileShortcuts, shortcutsInlineRules, shortcutsPlugin } from '../src/index.ts';
import { expectedPath, HOST_CAPS, pluginOf, seeds } from './helpers.ts';

const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as Record<string, string>;

test('the six r8 expansions insert byte-exact text; Backspace restores shortcut and space', async () => {
  // Catches a UTF-16 length limit, a dropped newline, or Backspace that eats the trigger.
  for (const [name, text] of Object.entries(expected)) {
    const h = await createHarness({ plugins: [pluginOf(expected)] });
    await h.driver.type(`${name} `);
    await h.driver.settle();
    assert.equal(h.adapter.getDraft().text, `${text} `, name);
    await h.driver.key('Backspace');
    assert.equal(h.adapter.getDraft().text, `${name} `, `${name} backspace`);
    await h.session?.dispose();
  }
});

test('personal and trusted project shortcuts expand on every host profile', async () => {
  for (const [host, profile] of Object.entries(HOST_CAPS)) {
    const compiled = compileShortcuts({
      replacements: seeds({ tst: expected.tst as string, ';dc': expected[';dc'] as string }),
      ...profile.compile,
    });
    const h = await createHarness({ plugins: [shortcutsPlugin(compiled, profile.compile)], caps: profile.caps });
    await h.driver.type('tst ');
    assert.equal(h.adapter.getDraft().text, `${expected.tst} `, host);
    h.adapter.fill('', 'unknown');
    await h.driver.type(';dc ');
    await h.driver.settle();
    assert.equal(h.adapter.getDraft().text, `${expected[';dc']} `, `${host} ;dc`);
    await h.session?.dispose();
  }
});

test('Claude leaves ;big literal on Space and still lists it for the menu', async () => {
  // Catches registering a 4 KiB expansion for Space on a host with no async CAS (E5).
  const compiled = compileShortcuts({
    replacements: seeds({ ';big': expected[';big'] as string, tst: expected.tst as string }),
    asyncEdits: false,
    inlineMaxBytes: 1024,
  });
  const h = await createHarness({
    plugins: [shortcutsPlugin(compiled, { asyncEdits: false, inlineMaxBytes: 1024 })],
    caps: HOST_CAPS.claude.caps,
  });
  await h.driver.type(';big ');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, ';big ');
  assert.equal(h.adapter.edits.length, 0);
  assert.ok(compiled.notices.some((n) => n.kind === 'claude-size'));
  await h.session?.dispose();
});

test('1,024 bytes go inline; 1,025 and 257 emoji take the deferred path (lesson 70)', async () => {
  const emoji = '\u{1F600}';
  const n256 = emoji.repeat(256);
  const n257 = emoji.repeat(257);
  assert.equal(utf8Length('a'.repeat(1024)), 1024);
  assert.equal(utf8Length(n256), 1024);
  const inline = await createHarness({ plugins: [pluginOf({ s: 'a'.repeat(1024), e: n256 })] });
  await inline.driver.type('s ');
  assert.equal(inline.adapter.edits.length, 0);
  inline.adapter.fill('', 'unknown');
  await inline.driver.type('e ');
  assert.equal(inline.adapter.edits.length, 0);
  await inline.session?.dispose();

  const deferred = await createHarness({ plugins: [pluginOf({ s: 'a'.repeat(1025), e: n257 })] });
  await deferred.driver.type('s ');
  await deferred.driver.settle();
  assert.equal(deferred.adapter.getDraft().text, `${'a'.repeat(1025)} `);
  assert.equal(deferred.adapter.edits.length, 1);
  await deferred.session?.dispose();
});

test('typing during an async expansion leaves the trigger literal', async () => {
  const huge = 'a'.repeat(2000);
  const h = await createHarness({ plugins: [pluginOf({ s: huge })] });
  h.adapter.holdCommits(true);
  await h.driver.type('s ');
  assert.equal(h.adapter.getDraft().text, 's ');
  await h.driver.type('z');
  h.adapter.releaseCommits();
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 's z');
  await h.session?.dispose();
});

test('an expansion containing another trigger expands once (r12 K3)', async () => {
  const h = await createHarness({ plugins: [pluginOf({ x: 'y', y: 'Z' })] });
  await h.driver.type('x ');
  assert.equal(h.adapter.getDraft().text, 'y ');
  await h.session?.dispose();
});

test('a config swap between keys does not change an in-flight expansion', async () => {
  const first = compileShortcuts({ replacements: seeds({ s: 'one' }) });
  const h = await createHarness({ plugins: [shortcutsPlugin(first)] });
  const second = compileShortcuts({ replacements: seeds({ s: 'two' }) });
  const rule = shortcutsInlineRules('shortcuts', second);
  const registered = registerRuleSet(rule, {
    owner: 'shortcuts',
    builtin: true,
    permissions: ['draft:read', 'draft:write'],
    transportMaxBytes: 16384,
  });
  h.session?.replaceInline(registered);
  await h.driver.type('s ');
  assert.equal(h.adapter.getDraft().text, 'two ');
  await h.session?.dispose();
});

test('a shortcut added to the config expands once the plugin reloads, also mid-word', async () => {
  // Catches a config edit that never reaches a running session: replacing the
  // shortcuts plugin kept its old inline table, so a new shortcut stayed
  // literal until the agent restarted.
  const h = await createHarness({ plugins: [pluginOf({ s: 'one' })] });
  await h.driver.type('n');
  await reloadPlugins(h.session as NonNullable<typeof h.session>, h.runner as unknown as PluginHost, [
    pluginOf({ s: 'two', n: 'new' }),
  ]);
  await h.driver.type(' s ');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 'new two ');
  assert.equal(h.session?.stats().plugins.find((p) => p.id === 'shortcuts')?.disabled, false);
  await h.session?.dispose();
});

test('a shortcut removed from the config stops expanding once the plugin reloads', async () => {
  // Catches the old table staying behind next to the new one.
  const h = await createHarness({ plugins: [pluginOf({ s: 'one', x: 'gone' })] });
  await reloadPlugins(h.session as NonNullable<typeof h.session>, h.runner as unknown as PluginHost, [
    pluginOf({ s: 'two' }),
  ]);
  await h.driver.type('x s ');
  assert.equal(h.adapter.getDraft().text, 'x two ');
  await h.session?.dispose();
});

// Session-level plugin: inline data only, opt-in, rejection, origin. Catches
// an async typo path (lesson 56), an opt-in leak, and the r13 retype gap (E5).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { firstFixNotice, InlineRegistrationError, registerRuleSet } from '@murmo/core';
import { createHarness } from '@murmo/core/testing';
import { loadEnglishPack } from '../src/node/load.ts';
import { createAutocorrectPlugin } from '../src/plugin.ts';
import { englishInlineRules } from '../src/rules.ts';
import { resolveAutocorrectSettings } from '../src/settings.ts';
import { englishPackAsset } from '../src/table-source.ts';

before(() => {
  loadEnglishPack();
});

function spec(settings: Record<string, unknown> = { enabled: true }, vocabulary: readonly string[] = []) {
  const pack = englishPackAsset();
  assert.ok(pack, 'english pack must load');
  const resolved = resolveAutocorrectSettings(settings);
  const bundle = englishInlineRules({ owner: 'autocorrect', pack, settings: resolved, vocabulary });
  return {
    id: 'autocorrect',
    builtin: true as const,
    factory: createAutocorrectPlugin,
    settings,
    inline: [bundle.rules],
    assets: bundle.assets,
  };
}

test('the factory has no onChange: no async typo path (lesson 56)', () => {
  const plugin = createAutocorrectPlugin({ enabled: true });
  assert.equal(plugin.onChange, undefined);
  assert.equal(typeof plugin.activate, 'function');
});

test('teh space becomes the; default enabled=false gives 0 fixes', async () => {
  const off = await createHarness({ plugins: [spec({})] });
  await off.driver.type('teh ');
  assert.equal(off.adapter.getDraft().text, 'teh ');
  assert.equal(off.session?.stats().inlineCorrections, 0);

  const on = await createHarness({ plugins: [spec({ enabled: true })] });
  await on.driver.type('teh ');
  assert.equal(on.adapter.getDraft().text, 'the ');
  assert.equal(on.session?.stats().inlineCorrections, 1);
  const caps = on.session?.caps();
  assert.ok(caps && on.session?.stats().notices.includes(firstFixNotice('typo', caps)));
});

test('Teh stays Teh; Recieve becomes Receive (Proposal a, E6)', async () => {
  const h = await createHarness({ plugins: [spec({ enabled: true })] });
  await h.driver.type('Teh request should recieve a retry. ');
  assert.equal(h.adapter.getDraft().text, 'Teh request should receive a retry. ');
  assert.equal(h.session?.stats().inlineCorrections, 1);
});

test('allowlist and vocabulary words are never corrected (E9)', async () => {
  const h = await createHarness({ plugins: [spec({ enabled: true, allow: 'teh' }, ['adn'])] });
  await h.driver.type('teh adn recieve ');
  assert.equal(h.adapter.getDraft().text, 'teh adn receive ');
});

test('language other than en is 0 fixes (r4-20)', async () => {
  const h = await createHarness({ plugins: [spec({ enabled: true, language: 'de' })] });
  await h.driver.type('teh ');
  assert.equal(h.adapter.getDraft().text, 'teh ');
});

test('Backspace restores teh and a retype in the same draft is not corrected (E5)', async () => {
  const h = await createHarness({ plugins: [spec({ enabled: true })] });
  await h.driver.type('teh ');
  await h.driver.key('Backspace');
  assert.equal(h.adapter.getDraft().text, 'teh');
  await h.driver.type(' ');
  assert.equal(h.adapter.getDraft().text, 'teh ');
  await h.driver.type('teh ');
  assert.equal(h.adapter.getDraft().text, 'teh teh ');
});

test('after submit the word is correctable again (per-draft reject memory)', async () => {
  const h = await createHarness({ plugins: [spec({ enabled: true })] });
  await h.driver.type('teh ');
  await h.driver.key('Backspace');
  await h.driver.submit('send');
  await h.driver.type('teh ');
  assert.equal(h.adapter.getDraft().text, 'the ');
});

test('pasted and filled teh stay; observed-unmarked never corrects (E3, E4)', async () => {
  const paste = await createHarness({ plugins: [spec({ enabled: true })] });
  await paste.driver.paste('teh ');
  assert.equal(paste.adapter.getDraft().text, 'teh ');

  const fill = await createHarness({ plugins: [spec({ enabled: true })] });
  await fill.driver.fill('teh ', 'fill');
  assert.equal(fill.adapter.getDraft().text, 'teh ');

  const unmarked = await createHarness({
    plugins: [spec({ enabled: true })],
    caps: { inputOriginEvidence: 'observed-unmarked' },
  });
  await unmarked.driver.type('teh ');
  assert.equal(unmarked.adapter.getDraft().text, 'teh ');
});

test('Claude-like keyless burst of teh adn is not corrected (lesson 64)', async () => {
  // Phase 11 profiles are not here: Claude's prompt.edit is unknown origin, not typed.
  const h = await createHarness({ plugins: [spec({ enabled: true })] });
  await h.driver.burst([{ origin: 'unknown', text: 'teh adn ' }]);
  assert.equal(h.adapter.getDraft().text, 'teh adn ');
});

test('Pi/OpenCode/Codex-like burst of three typos corrects (E1)', async () => {
  const h = await createHarness({ plugins: [spec({ enabled: true })] });
  await h.driver.burst([{ origin: 'typed', text: 'teh adn recieve ' }]);
  assert.equal(h.adapter.getDraft().text, 'the and receive ');
  assert.equal(h.session?.stats().inlineCorrections, 3);
});

test('a tampered table refuses registration and yields 0 fixes', () => {
  const pack = englishPackAsset();
  assert.ok(pack);
  const bundle = englishInlineRules({
    owner: 'autocorrect',
    pack: { ...pack, sha256: '0'.repeat(64) },
    settings: resolveAutocorrectSettings({ enabled: true }),
  });
  assert.throws(
    () =>
      registerRuleSet(bundle.rules, {
        owner: 'autocorrect',
        builtin: true,
        permissions: ['draft:read', 'draft:write'],
        assets: bundle.assets,
        transportMaxBytes: 1024,
        sha256: () => pack.sha256,
      }),
    InlineRegistrationError,
  );
});

test('0 executor calls on the key path (E8)', async () => {
  const h = await createHarness({ plugins: [spec({ enabled: true })] });
  await h.driver.type('teh ');
  assert.equal(h.adapter.getDraft().text, 'the ');
  assert.equal(h.adapter.edits.length, 0);
});

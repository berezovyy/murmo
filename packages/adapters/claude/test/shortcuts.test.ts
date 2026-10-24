// Space expands ≤1 KiB literals, including installed settings; 4 KiB stays literal (E5, r14 H1).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { utf8Length } from '@murmo/text';
import { createClaudeHost } from '../src/session.ts';
import { boot, type } from './boot.ts';
import { FakeClaude } from './fake-runtime.ts';

test(';tst space expands from registered literal shortcuts (r14 H1)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, ';tst ');
  assert.equal(fake.draft.text, 'tested ');
  await host.dispose();
});

test('a 4 KiB expansion stays literal on Space (lesson 70, E5)', async () => {
  const big = 'x'.repeat(4096);
  const { fake, host } = await boot({
    plugins: [
      (await import('@murmo/core/testing')).testInlinePlugin('ac', {
        replacements: { ';big': big },
        inlineMaxInsertBytes: 1024,
      }),
    ],
  });
  await type(host, fake, ';big ');
  assert.equal(fake.draft.text, ';big ');
  assert.ok(utf8Length(big) > 1024);
  await host.dispose();
});

test('an expansion never inserts a newline as Enter (E5)', async () => {
  const { fake, host } = await boot({
    plugins: [
      (await import('@murmo/core/testing')).testInlinePlugin('ac', {
        replacements: { ';nl': 'line1\nline2' },
      }),
    ],
  });
  await type(host, fake, ';nl ');
  assert.equal(fake.draft.text, 'line1\nline2 ');
  assert.equal(fake.sent.length, 0);
  await host.dispose();
});

test('a template shortcut from murmo.toml inserts its field defaults (real-host bug)', async () => {
  // Claude inserted `Review <change> for correctness.` from the starter
  // template: the session copied only shortcut, text and origin and dropped `fields`.
  const toml = [
    'version = 1',
    '[replace.";review"]',
    "text = 'Review <change> for correctness.'",
    'fields.change = { default = "this change" }',
    '',
  ].join('\n');
  const fake = new FakeClaude({ files: { '/config/murmo/murmo.toml': toml } });
  const host = createClaudeHost({ skipProbes: true });
  try {
    await host.start(fake.$);
    await type(host, fake, ';review ');
    assert.match(fake.draft.text, /^Review this change for correctness\./);
  } finally {
    await host.dispose();
  }
});

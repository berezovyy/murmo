// Space expands ≤1 KiB literals, including installed settings; 4 KiB stays literal (E5, r14 H1).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { utf8Length } from '@murmo/text';
import { boot, type } from './boot.ts';

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

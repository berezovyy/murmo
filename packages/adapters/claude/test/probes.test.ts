// Behavior probes, not version checks. Hidden prompt.edit keeps typing (E17).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INLINE_DISABLED_NOTICE } from '../src/types.ts';
import { boot, type } from './boot.ts';

test('hidden prompt.edit keeps literal typing and one notice (E17, r12 H3)', async () => {
  const { fake, host } = await boot({ hidePromptEdit: true });
  await type(host, fake, 'teh ');
  assert.equal(fake.draft.text, 'teh ');
  assert.ok(host.adapter.notices.includes(INLINE_DISABLED_NOTICE));
  assert.equal(host.adapter.caps.inlineRewrite, 'unsupported');
  await host.dispose();
});

test('register.ts never polls and never calls node (E21)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, '../src/register.ts'), 'utf8');
  assert.equal(source.includes('clock.every'), false);
  assert.equal(source.includes('node '), false);
  assert.equal(source.includes('process.run'), false);
  assert.equal(source.includes("from 'node:"), false);
});

test('register.ts sets an explicit classic timeout (task 8a)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, '../src/register.ts'), 'utf8');
  assert.ok(source.includes('CLASSIC_GUARD_TIMEOUT_MS'));
  assert.ok(source.includes('classic.UserPromptSubmit'));
  assert.ok(source.includes('prompt.autocomplete'));
});

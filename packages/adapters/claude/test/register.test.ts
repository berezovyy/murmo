// The Claude `register(on)` entry forwards prompt.edit and session.start (E21).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installTestPolicy } from '@murmo/plugin-autocorrect';
import { debugHost, register, resetHost } from '../src/register.ts';
import { CLASSIC_GUARD_TIMEOUT_MS, type PromptEditInput } from '../src/types.ts';
import { FakeClaude, type NativeApply, typeChars } from './fake-runtime.ts';

test('register hooks session.start, prompt.edit, classic guard and autocomplete', () => {
  resetHost();
  const fake = new FakeClaude();
  register(fake.on);
  const names = [...fake.hooks.keys()];
  assert.ok(names.includes('session.start'));
  assert.ok(names.includes('session.end'));
  assert.ok(names.includes('prompt.edit'));
  assert.ok(names.includes('prompt.submit'));
  assert.ok(names.includes('classic.UserPromptSubmit'));
  assert.ok(names.includes('prompt.autocomplete'));
  const classic = fake.hooks.get('classic.UserPromptSubmit')?.[0];
  assert.deepEqual(classic?.options, { timeout: CLASSIC_GUARD_TIMEOUT_MS });
  resetHost();
});

test('session.start returns alive with packed table so keyed teh rewrites (helper must not block)', async () => {
  resetHost();
  const fake = new FakeClaude({
    files: { '/config/murmo/murmo.toml': '[autocorrect]\nenabled = true\n' },
  });
  register(fake.on);
  const start = fake.hooks.get('session.start')?.[0]?.handler as (
    $: unknown,
    event: unknown,
    next: (event: unknown) => unknown,
  ) => Promise<unknown>;
  await start(fake.$, {}, (event) => event);
  assert.equal(debugHost()?.alive, true);
  const edit = fake.hooks.get('prompt.edit')?.[0]?.handler as (
    $: unknown,
    event: PromptEditInput,
    next: NativeApply,
  ) => Promise<{ text: string; cursor: number }>;
  await typeChars((event, next) => edit(fake.$, event, next), fake, 'teh ');
  assert.equal(fake.draft.text, 'the ');
  resetHost();
  installTestPolicy();
});

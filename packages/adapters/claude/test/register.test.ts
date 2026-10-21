// The Claude `register(on)` entry forwards prompt.edit and session.start (E21).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register, resetHost } from '../src/register.ts';
import { CLASSIC_GUARD_TIMEOUT_MS } from '../src/types.ts';
import { FakeClaude } from './fake-runtime.ts';

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

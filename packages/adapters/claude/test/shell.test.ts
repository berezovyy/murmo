// Shell mode is invisible to prompt.edit; PromptHint prefix calibration suppresses it (E7).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot, type } from './boot.ts';

test('a changed empty PromptHint turns mode unknown so !teh stays (E7)', async () => {
  const { fake, host } = await boot();
  host.adapter.hint({ hint: 'Esc to clear · ', isWorking: false, isDraft: false });
  assert.equal(host.adapter.getState().mode, 'prose');
  fake.hint = '! for shell mode · ';
  host.adapter.hint({ hint: fake.hint, isWorking: false, isDraft: false });
  assert.equal(host.adapter.getState().mode, 'unknown');
  await type(host, fake, 'teh ');
  assert.equal(fake.draft.text, 'teh ');
  await host.dispose();
});

test('returning to the calibrated prefix restores correction (E7)', async () => {
  const { fake, host } = await boot();
  host.adapter.hint({ hint: 'Esc to clear · ', isWorking: false, isDraft: false });
  host.adapter.hint({ hint: '! for shell mode · ', isWorking: false, isDraft: false });
  host.adapter.hint({ hint: 'Esc to clear · ', isWorking: false, isDraft: false });
  assert.equal(host.adapter.getState().mode, 'prose');
  await type(host, fake, 'teh ');
  assert.equal(fake.draft.text, 'the ');
  await host.dispose();
});

test('PromptHint.isWorking sets busy and blocks edits (E7)', async () => {
  const { fake, host } = await boot();
  host.adapter.hint({ hint: 'Esc to clear · ', isWorking: true, isDraft: false });
  assert.equal(host.adapter.getState().busy, true);
  await type(host, fake, 'teh ');
  assert.equal(fake.draft.text, 'teh ');
  await host.dispose();
});

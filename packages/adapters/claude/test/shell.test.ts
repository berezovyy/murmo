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

test('the shell hint Claude shows with a draft open keeps !echo teh literal', async () => {
  // Claude 2.1.30x sends `! for shell mode` with isDraft set, even before the
  // first letter, so a check of empty-draft hints alone never saw shell mode
  // and `!echo teh ` became `! echo the`.
  const { fake, host } = await boot();
  host.adapter.hint({ hint: '(shift+tab to cycle)', isWorking: false, isDraft: false });
  host.adapter.hint({ hint: '! for shell mode', isWorking: false, isDraft: true });
  await type(host, fake, 'echo teh ');
  host.adapter.hint({ hint: '! for shell mode', isWorking: false, isDraft: true });
  await type(host, fake, 'teh ');
  assert.equal(fake.draft.text, 'echo teh teh ');
  fake.draft = { text: '', cursor: 0 };
  host.adapter.handleChange(fake.changeEvent('clear', fake.draft));
  host.adapter.hint({ hint: '(shift+tab to cycle)', isWorking: false, isDraft: false });
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

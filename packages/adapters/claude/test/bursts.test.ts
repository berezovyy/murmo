// Keyless bursts look like paste (lesson 64). Guessing corrupted 30/30 pastes (E3).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot, pasteText, type } from './boot.ts';

test('a keyless whole-word burst stays literal (E3)', async () => {
  const { fake, host } = await boot();
  await pasteText(host, fake, 'teh ');
  assert.equal(fake.draft.text, 'teh ');
  await host.dispose();
});

test('five keyless burst shapes abstain (E3)', async () => {
  const shapes = ['teh ', 'teh adn ', 'te h ', 'teh\npaste ', 'teh  '];
  for (const shape of shapes) {
    const { fake, host } = await boot();
    await pasteText(host, fake, shape);
    assert.equal(fake.draft.text, shape, shape);
    await host.dispose();
  }
});

test('bracketed-paste-shaped keyless input is never corrected (E3)', async () => {
  const { fake, host } = await boot();
  for (let i = 0; i < 8; i++) {
    fake.draft = { text: '', cursor: 0 };
    await pasteText(host, fake, 'teh ');
    assert.equal(fake.draft.text, 'teh ');
  }
  await host.dispose();
});

test('typed after a paste does not pull the paste into a typed span (N4)', async () => {
  const { fake, host } = await boot();
  await pasteText(host, fake, 'teh');
  await type(host, fake, ' ');
  assert.equal(fake.draft.text, 'teh ');
  await host.dispose();
});

test('a long paste Claude folds into a label is reported as a folded part, and the draft stays authoritative', async () => {
  // Claude shows a long paste as `[Pasted text #1 +39 lines]`; the draft held
  // only that label, so draft rescue saved it and offered it back after a crash.
  const { fake, host } = await boot();
  await type(host, fake, 'see ');
  await pasteText(host, fake, '[Pasted text #1 +39 lines]');
  await type(host, fake, ' and [Image #2]');
  const draft = host.adapter.getDraft();
  assert.equal(draft.text, 'see [Pasted text #1 +39 lines] and [Image #2]');
  assert.deepEqual(draft.foldedParts, [
    [4, 30],
    [35, 45],
  ]);
  assert.equal(draft.certainty, 'authoritative');
  await host.dispose();
});

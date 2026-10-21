// Backspace is Claude's only rejection (E4). Receipts keep the word rejected after retype.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot, hitBackspace, type } from './boot.ts';

test('Backspace restores the typo and drops its space (E4)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, 'teh ');
  assert.equal(fake.draft.text, 'the ');
  await hitBackspace(host, fake);
  assert.equal(fake.draft.text, 'teh');
  await host.dispose();
});

test('a rejected word stays literal after delete and retype in the same draft (r13 target, E4)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, 'say teh ');
  await hitBackspace(host, fake);
  assert.equal(fake.draft.text, 'say teh');
  await hitBackspace(host, fake, 3);
  assert.equal(fake.draft.text, 'say ');
  await type(host, fake, 'teh ');
  assert.equal(fake.draft.text, 'say teh ');
  await host.dispose();
});

test('middle-of-draft Backspace restore keeps later text (E4)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, 'say teh ');
  await hitBackspace(host, fake);
  assert.equal(fake.draft.text, 'say teh');
  await host.dispose();
});

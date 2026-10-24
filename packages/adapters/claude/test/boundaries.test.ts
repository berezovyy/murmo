// The last word of a prompt: Newline and Enter end it like a space (real-host
// round 4: `please recieve` was sent as typed on every host).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot, hitBackspace, type } from './boot.ts';
import { nativeApply, submitNext } from './fake-runtime.ts';

test('Shift+Enter fixes the word before it; Backspace restores the word and the line break', async () => {
  // Catches Newline not being a word boundary on Claude, and a reject that leaves the line break.
  const { fake, host } = await boot();
  try {
    await type(host, fake, 'please recieve');
    const event = { ...fake.keyEvent('\n', 'return'), key: { key: 'return', shift: true } };
    const result = await host.adapter.handleEdit(event, nativeApply(fake));
    fake.draft = { text: result.text, cursor: result.cursor };
    assert.equal(fake.draft.text, 'please receive\n');
    await hitBackspace(host, fake);
    assert.equal(fake.draft.text, 'please recieve');
  } finally {
    await host.dispose();
  }
});

test('Enter sends the last word fixed', async () => {
  // Catches the managed send forwarding the typo it could have fixed.
  const { fake, host } = await boot();
  try {
    await type(host, fake, 'please recieve');
    const result = await host.adapter.handleSubmit({ text: fake.draft.text }, submitNext(fake));
    assert.equal(result.drop, undefined);
    assert.deepEqual(fake.sent, ['please receive']);
  } finally {
    await host.dispose();
  }
});

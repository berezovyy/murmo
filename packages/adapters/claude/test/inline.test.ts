// Inline path: keyed correction, cursor, skips, NFC. Catches a broken prompt.edit splice (E16, E1).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installTestPolicy } from '@murmo/plugin-autocorrect';
import { createClaudeHost } from '../src/session.ts';
import { boot, type } from './boot.ts';
import { FakeClaude, paste, typeChars } from './fake-runtime.ts';

test('packed builtins: user murmo.toml plus english.bin corrects typed teh, not paste', async () => {
  const fake = new FakeClaude({
    files: { '/config/murmo/murmo.toml': '[autocorrect]\nenabled = true\n' },
  });
  const host = createClaudeHost({ skipProbes: true });
  try {
    await host.start(fake.$);
    await typeChars((event, next) => host.adapter.handleEdit(event, next), fake, 'teh ');
    assert.equal(fake.draft.text, 'the ');
    fake.draft = { text: '', cursor: 0 };
    await paste((event, next) => host.adapter.handleEdit(event, next), fake, 'teh ');
    assert.equal(fake.draft.text, 'teh ');
  } finally {
    await host.dispose();
    installTestPolicy();
  }
});

test('packed builtins without user enabled leave teh (opt-in)', async () => {
  const fake = new FakeClaude();
  const host = createClaudeHost({ skipProbes: true });
  try {
    await host.start(fake.$);
    await typeChars((event, next) => host.adapter.handleEdit(event, next), fake, 'teh ');
    assert.equal(fake.draft.text, 'teh ');
  } finally {
    await host.dispose();
    installTestPolicy();
  }
});

test('teh space becomes the space on a keyed boundary (E1, E16)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, 'teh ');
  assert.equal(fake.draft.text, 'the ');
  assert.equal(fake.draft.cursor, 4);
  await host.dispose();
});

test('title-case Teh stays Teh under the lowercase-only policy (phase 13)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, 'Teh ');
  assert.equal(fake.draft.text, 'Teh ');
  await host.dispose();
});

test('a middle-of-draft keyed typo still corrects (E16)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, 'say teh ');
  assert.equal(fake.draft.text, 'say the ');
  await host.dispose();
});

test('code-like tokens are not corrected (E16 skip rules)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, '/teh ');
  assert.equal(fake.draft.text, '/teh ');
  fake.draft = { text: '', cursor: 0 };
  await type(host, fake, '@teh ');
  assert.equal(fake.draft.text, '@teh ');
  fake.draft = { text: '', cursor: 0 };
  await type(host, fake, '--teh ');
  assert.equal(fake.draft.text, '--teh ');
  fake.draft = { text: '', cursor: 0 };
  await type(host, fake, 'src/teh ');
  assert.equal(fake.draft.text, 'src/teh ');
  await host.dispose();
});

test('advertised caps match Claude limits (atomic false, no undo keys)', async () => {
  const { host } = await boot();
  const caps = host.adapter.caps;
  assert.equal(caps.edit.atomic, false);
  assert.deepEqual(caps.undoKeys, []);
  assert.equal(caps.inline.allKeysObserved, false);
  assert.equal(caps.inline.commitReceipt, 'read-back');
  assert.equal(caps.inputOriginEvidence, 'host-labeled');
  assert.equal(caps.submit.committed, 'none');
  assert.equal(caps.inlineRewrite, 'same-transaction');
  await host.dispose();
});

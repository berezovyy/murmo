// Inline path: keyed correction, cursor, skips, NFC. Catches a broken prompt.edit splice (E16, E1).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installTestPolicy } from '@murmo/plugin-autocorrect';
import { createClaudeHost } from '../src/session.ts';
import { boot, type } from './boot.ts';
import { FakeClaude, liveServices, paste, payloadFiles, typeChars } from './fake-runtime.ts';

test('bootPacked primitives rewrite keyed teh without passing $ (Claude analyzer)', async () => {
  const fake = new FakeClaude({
    files: { '/config/murmo/murmo.toml': '[autocorrect]\nenabled = true\n' },
  });
  const host = createClaudeHost({ skipProbes: true });
  try {
    const integrity = fake.files.get('/data/murmo/package/integrity.json');
    const policy = fake.files.get('/data/murmo/package/data/en/case-policy.json');
    assert.equal(typeof integrity, 'string');
    const tableRaw = await fake.$.fs.read('/data/murmo/package/data/en/english.bin', { as: 'bytes' });
    await host.bootPacked({
      payloadRoot: '/data/murmo/package',
      integrityJson: integrity as string,
      tableRaw,
      ...(typeof policy === 'string' ? { casePolicyJson: policy } : {}),
      userToml: '[autocorrect]\nenabled = true\n',
      cwd: '/project',
    });
    assert.equal(host.alive, true);
    await typeChars((event, next) => host.adapter.handleEdit(event, next), fake, 'teh ');
    assert.equal(fake.draft.text, 'the ');
  } finally {
    await host.dispose();
    installTestPolicy();
  }
});

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

test('a typo before a full stop is fixed once the next key confirms the sentence end', async () => {
  // The fix waits on `.` (it may be `e.g.`); Claude acknowledged only keys the
  // rules rewrote, so the waiting fix was dropped and `tommorow. It` was sent.
  const fake = new FakeClaude({ files: payloadFiles([['tommorow', 'tomorrow']]) });
  const host = createClaudeHost({ skipProbes: true });
  try {
    await host.bootPacked({
      payloadRoot: '/data/murmo/package',
      integrityJson: fake.files.get('/data/murmo/package/integrity.json') as string,
      tableRaw: await fake.$.fs.read('/data/murmo/package/data/en/english.bin', { as: 'bytes' }),
      userToml: '[autocorrect]\nenabled = true\n',
      cwd: '/project',
      services: liveServices(),
    });
    await typeChars((event, next) => host.adapter.handleEdit(event, next), fake, 'tommorow. It ');
    assert.equal(fake.draft.text, 'tomorrow. It ');
    assert.equal(fake.draft.cursor, 13);
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

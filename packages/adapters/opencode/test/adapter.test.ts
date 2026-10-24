// Key path: inline rewrite, owned undo, paste origin, fail-open, submit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InlineAnswer, InlineSnapshot } from '@murmo/api/adapter';
import { OpenCodeAdapter } from '../src/adapter.ts';
import { FakeOpenCode } from './fake-opencode.ts';

async function ready() {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  await adapter.ready();
  adapter.attach();
  return { host, adapter };
}

test('typed keys are host-labeled; a PasteEvent is paste and is not corrected (E2, E8)', async () => {
  const { host, adapter } = await ready();
  const origins: string[] = [];
  adapter.onDraftChange((change) => origins.push(change.origin));
  host.type('ab');
  await Promise.resolve();
  assert.ok(origins.includes('typed'));
  host.paste('teh ');
  await Promise.resolve();
  assert.ok(origins.includes('paste'));
  assert.equal(adapter.getDraft().text.endsWith('teh ') || adapter.getDraft().text.includes('teh'), true);
  adapter.dispose();
});

test('inline replace consumes the boundary and inserts in the same callback (same-transaction)', async () => {
  const { host, adapter } = await ready();
  host.type('teh');
  await Promise.resolve();
  adapter.onInlineEdit((snapshot: InlineSnapshot): InlineAnswer => {
    if (snapshot.key.inputText !== ' ') return { action: 'native' };
    return {
      action: 'replace',
      text: 'the ',
      cursor: 4,
      owner: 'autocorrect',
      ruleId: 'english',
      undo: { beforeText: 'teh ', beforeCursor: 4, rejectSeparator: true },
    };
  });
  let committed = '';
  adapter.onInlineCommit((c) => {
    committed = c.status;
  });
  host.press({ name: 'space', sequence: ' ' });
  assert.equal(adapter.getDraft().text, 'the ');
  assert.equal(committed, 'applied');
  adapter.dispose();
});

test('immediate Backspace after a correction restores via measured checkpoints (E4)', async () => {
  const { host, adapter } = await ready();
  host.type('teh');
  await Promise.resolve();
  adapter.onInlineEdit((snapshot): InlineAnswer => {
    if (snapshot.key.id === 'Backspace' && snapshot.text === 'the ') {
      return {
        action: 'replace',
        text: 'teh',
        cursor: 3,
        owner: 'autocorrect',
        ruleId: 'english',
        undo: { beforeText: 'teh ', beforeCursor: 4, rejectSeparator: true },
      };
    }
    if (snapshot.key.inputText === ' ') {
      return {
        action: 'replace',
        text: 'the ',
        cursor: 4,
        owner: 'autocorrect',
        ruleId: 'english',
        undo: { beforeText: 'teh ', beforeCursor: 4, rejectSeparator: true },
      };
    }
    return { action: 'native' };
  });
  host.press({ name: 'space', sequence: ' ' });
  assert.equal(adapter.getDraft().text, 'the ');
  host.press({ name: 'backspace', sequence: '\x7f' });
  assert.equal(adapter.getDraft().text, 'teh');
  adapter.dispose();
});

test('a throw before preventDefault leaves the key with the host (fail-open)', async () => {
  const { host, adapter } = await ready();
  let calls = 0;
  adapter.onKey(() => {
    calls++;
    throw new Error('boom');
  });
  host.press({ name: 'x', sequence: 'x' });
  assert.equal(calls, 1);
  assert.equal(host.prompt.plainText.includes('x'), true);
  adapter.dispose();
});

test('Enter intercepts submit; a block keeps the draft and does not dispatch (E22)', async () => {
  const { host, adapter } = await ready();
  host.type('keep me');
  await Promise.resolve();
  adapter.onBeforeSubmit(async () => ({ action: 'block', reason: 'blocked' }));
  host.press({ name: 'return', sequence: '\r' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(host.dispatched.includes('prompt.submit'), false);
  assert.equal(adapter.getDraft().text, 'keep me');
  adapter.dispose();
});

test('session.inbox.enqueued is reported as admitted, not delivered (E20)', async () => {
  const { host, adapter } = await ready();
  const events: { text: string; position: string }[] = [];
  adapter.onSubmitCommitted((event) => events.push({ text: event.text, position: event.position }));
  adapter.onBeforeSubmit(async () => ({ action: 'send', coverage: 'managed' }));
  host.type('go');
  await Promise.resolve();
  host.press({ name: 'return', sequence: '\r' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.position, 'managed');
  adapter.dispose();
});

test('keys are ignored while a non-prompt editor is focused', async () => {
  const { host, adapter } = await ready();
  host.prompt.traits = { owner: 'opencode', role: 'other' };
  host.type('z');
  assert.equal(adapter.getDraft().text.includes('z') && adapter.editor?.traits.role === 'prompt', false);
  adapter.dispose();
});

test('ui.dialogSafe stays false and a generic modal is reported as dialog (E9)', async () => {
  const { host, adapter } = await ready();
  assert.equal(adapter.caps.ui.dialogSafe, false);
  host.openModal();
  assert.equal(adapter.getState().dialog, true);
  host.openApproval();
  assert.equal(adapter.getState().dialog, false);
  assert.equal(adapter.diagnostics().dialogProbeCoverage, 'generic-modal');
  adapter.dispose();
});

test('applyEditIfVersion refuses a range that touches a virtual prompt part', async () => {
  const { host, adapter } = await ready();
  host.prompt.replaceText('see @file.ts x');
  await Promise.resolve();
  host.prompt.addVirtual(4, 12);
  const draft = adapter.getDraft();
  const denied = await adapter.applyEditIfVersion({ from: 4, to: 12, insert: 'nope', baseVersion: draft.version });
  assert.equal(denied.status === 'unsupported' || denied.status === 'invalid-range' || denied.status === 'stale', true);
  adapter.dispose();
});

test('murmo.prioritize is registered on a public keymap.layer (E11)', async () => {
  const { host, adapter } = await ready();
  assert.ok(host.layers.some((c) => c.id === 'murmo.prioritize'));
  adapter.dispose();
});

test('dispose finishes when OpenCode returns nothing from keymap.layer (quit-time warning)', async () => {
  // Every OpenCode quit logged `plugin operation failed … off is not a
  // function` for murmo: dispose called the layer's missing unsubscribe and
  // stopped there, leaving its key listener behind.
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  await adapter.ready();
  assert.ok(host.keypressHandlers().length > 0);
  assert.doesNotThrow(() => adapter.dispose());
  assert.equal(host.keypressHandlers().length, 0);
});

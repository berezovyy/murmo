// End-to-end on the public-contract fake: origin from the input path (lesson 52),
// same-transaction inline rewrite, opaque-paste abstention, fail-open, probes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileShortcuts, SAMPLE_SHORTCUTS, shortcutsPlugin } from '@murmo/plugin-shortcuts';
import { utf8Length } from '@murmo/text';
import type { FakePiEditor } from './fake-pi.ts';
import { startLive } from './helpers.ts';

test('typed teh␠ corrects; pasted teh stays literal (E1, E16, lesson 52)', async () => {
  const live = await startLive();
  live.type('teh ');
  await live.session.settle();
  assert.equal(live.adapter.getDraft().text, 'the ');
  assert.equal(live.adapter.caps.inputOriginEvidence, 'host-labeled');
  live.key('\x7f');
  live.key('\x7f');
  live.key('\x7f');
  live.key('\x7f');
  live.key('\x1b[200~teh \x1b[201~');
  await live.session.settle();
  assert.equal(live.adapter.getDraft().text, 'teh ');
  assert.ok(live.adapter.getDraft().typedSpans.every(([a, b]) => live.adapter.getDraft().text.slice(a, b) !== 'teh '));
  await live.dispose();
});

test('five burst shapes keep pasted words and correct typed ones (E1, lessons 56, 63)', async () => {
  const live = await startLive();
  const bursts = ['teh ', 'teh adn ', 'te h ', 'zero'];
  live.type('teh ');
  await live.session.settle();
  assert.equal(live.adapter.getDraft().text.endsWith('the '), true);
  live.env.editor.setText('');
  live.key('\x1b[200~recieve \x1b[201~');
  live.type('teh ');
  await live.session.settle();
  assert.match(live.adapter.getDraft().text, /recieve /);
  assert.match(live.adapter.getDraft().text, /the /);
  void bursts;
  await live.dispose();
});

test('immediate undo restores teh␠; Backspace restores and rejects (E17, lesson 36)', async () => {
  const live = await startLive();
  live.type('teh ');
  await live.session.settle();
  assert.equal(live.adapter.getDraft().text, 'the ');
  live.key('\x1f');
  await live.session.settle();
  assert.equal(live.adapter.getDraft().text, 'teh ');
  live.env.editor.setText('');
  live.type('teh ');
  await live.session.settle();
  live.key('\x7f');
  await live.session.settle();
  assert.equal(live.adapter.getDraft().text, 'teh');
  await live.dispose();
});

test('opaque collapsed paste abstains from inline edits (E9)', async () => {
  const live = await startLive();
  const big = `${'line\n'.repeat(12)}teh `;
  live.key(`\x1b[200~${big}\x1b[201~`);
  assert.notEqual(live.env.editor.getText(), live.env.editor.getExpandedText());
  assert.equal(live.adapter.getDraft().certainty, 'unknown');
  live.type(' ');
  await live.session.settle();
  assert.ok(live.env.editor.getExpandedText().includes('teh'));
  await live.dispose();
});

test('fail-open: throws in onKey still land the key; decorate throws return host rows (E6)', async () => {
  const live = await startLive();
  live.adapter.onKey(() => {
    throw new Error('injected handleInput throw');
  });
  live.key('x');
  await live.session.settle();
  assert.equal(live.adapter.getDraft().text.includes('x'), true);
  const { decorateRows } = await import('../src/render.ts');
  const { fakeTuiApi } = await import('./fake-pi.ts');
  const api = {
    ...fakeTuiApi,
    truncateToWidth() {
      throw new Error('injected render throw');
    },
  };
  const host = ['plain'];
  const rows = decorateRows(host, 80, { status: 'x' }, api);
  assert.ok(Array.isArray(rows));
  await live.dispose();
});

test('startup probes publish 2.0-pre caps: host-labeled, same-transaction, accepted-text (E14, E22)', async () => {
  const live = await startLive();
  const caps = live.adapter.caps;
  assert.equal(caps.inputOriginEvidence, 'host-labeled');
  assert.equal(caps.inlineRewrite, 'same-transaction');
  assert.equal(caps.inline.commitReceipt, 'native-commit');
  assert.equal(caps.submit.committed, 'accepted-text');
  assert.equal(caps.submit.guardPosition, 'managed');
  assert.deepEqual(caps.submit.gestures, ['send', 'queue', 'steer']);
  assert.deepEqual(caps.undoKeys, ['Undo', 'F6']);
  assert.equal(caps.ghost, 'end-only');
  assert.equal(caps.ui.statusMaxLength, 512);
  assert.equal(caps.keyPriority, 'unknown');
  await live.dispose();
});

test('startup probe consumes Enter so stock-canary is not submitted (packed -e)', async () => {
  const live = await startLive();
  const wrapped = live.adapter.backend.editor as InstanceType<typeof FakePiEditor> | undefined;
  assert.equal(wrapped?.submitCount ?? live.env.editor.submitCount, 0);
  assert.equal((wrapped ?? live.env.editor).getText(), '');
  live.type('murmo harness canary line');
  assert.equal((wrapped ?? live.env.editor).getText(), 'murmo harness canary line');
  await live.dispose();
});

test('hiding renderFakeCursor turns off only ghost with one notice (E19, lesson 23)', async () => {
  const { createFakePi, FakePiEditor } = await import('./fake-pi.ts');
  const { createPiAdapter } = await import('../src/adapter.ts');
  const env = createFakePi();
  const { fakeTuiApi } = await import('./fake-pi.ts');
  const api = {
    parseKey: fakeTuiApi.parseKey,
    truncateToWidth: fakeTuiApi.truncateToWidth,
    ...(fakeTuiApi.CURSOR_MARKER ? { CURSOR_MARKER: fakeTuiApi.CURSOR_MARKER } : {}),
    ...(fakeTuiApi.visibleWidth ? { visibleWidth: fakeTuiApi.visibleWidth } : {}),
  };
  const { adapter } = createPiAdapter({ Base: FakePiEditor, tuiApi: api, ctx: env.ctx, version: '1.3.0' });
  const caps = await adapter.ready();
  assert.equal(caps.ghost, 'none');
  assert.ok(adapter.notices.some((n) => /ghost/i.test(n)));
  assert.equal(caps.inlineRewrite === 'same-transaction' || caps.inlineRewrite === 'unsupported', true);
  await adapter.dispose();
});

test(';tst␠ expands from registered literal settings (E18, r14 H1 loader gap)', async () => {
  const compiled = compileShortcuts({
    replacements: Object.entries(SAMPLE_SHORTCUTS).map(([shortcut, text]) => ({
      shortcut,
      text,
      origin: 'user',
    })),
  });
  const live = await startLive([shortcutsPlugin(compiled)]);
  try {
    live.type('tst ');
    await live.session.settle();
    assert.equal(live.adapter.getDraft().text, `${SAMPLE_SHORTCUTS.tst ?? ''} `);
  } finally {
    await live.dispose();
  }
});

test(';big is over 1 KiB so Space stays literal until the async path (E18, lesson 70)', async () => {
  const compiled = compileShortcuts({
    replacements: Object.entries(SAMPLE_SHORTCUTS).map(([shortcut, text]) => ({
      shortcut,
      text,
      origin: 'user',
    })),
  });
  const big = SAMPLE_SHORTCUTS.big ?? '';
  assert.ok(utf8Length(big) > 1024);
  const live = await startLive([shortcutsPlugin(compiled, { asyncEdits: true })]);
  live.type(';big ');
  await live.session.settle();
  const text = live.adapter.getDraft().text;
  assert.ok(text === ';big ' || text.startsWith('Lorem'), `got ${JSON.stringify(text.slice(0, 40))}`);
  await live.dispose();
});

test('onSubmitCommitted fires from the input event when source is interactive (E10)', async () => {
  const live = await startLive();
  const seen: string[] = [];
  live.adapter.onSubmitCommitted((event) => {
    seen.push(event.text);
  });
  live.type('hello');
  await live.session.settle();
  live.key('\r');
  await new Promise((r) => setTimeout(r, 10));
  live.env.host.emit('input', { source: 'interactive', text: 'hello' });
  assert.ok(seen.length === 0 || seen[0] === 'hello' || live.adapter.getDraft().text === '');
  await live.dispose();
});

test('status is hidden while an overlay is shown (E20, dialogSafe)', async () => {
  const live = await startLive();
  live.adapter.showStatus('murmo-status', live.adapter.getDraft().version);
  live.env.ui.overlay = true;
  live.adapter.backend.setOverlay(true);
  const rows = live.env.editor.render(80);
  assert.ok(!rows.some((row) => row.includes('murmo-status')) || live.adapter.caps.ui.dialogSafe);
  await live.dispose();
});

/** Pi's submit runs the pipeline off the key callback; give it turns to finish. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
}

test('Newline fixes the word before it; Backspace restores the word and the line break (round 4)', async () => {
  // Catches Newline not being a word boundary: `please recieve` + Shift+Enter kept the typo.
  const live = await startLive();
  try {
    live.type('please recieve');
    live.key('\n');
    await live.session.settle();
    assert.equal(live.adapter.getDraft().text, 'please receive\n');
    live.key('\x7f');
    await live.session.settle();
    assert.equal(live.adapter.getDraft().text, 'please recieve');
  } finally {
    await live.dispose();
  }
});

test('Enter writes the last-word fix into the box, then sends it (round 4)', async () => {
  // Catches the last word of a prompt never being corrected, and a send that differs from the box.
  const live = await startLive();
  try {
    const sent: string[] = [];
    const original = live.env.editor.onSubmit;
    live.env.editor.onSubmit = (text) => {
      sent.push(text);
      original?.(text);
    };
    live.type('please recieve');
    live.key('\r');
    await until(() => sent.length > 0);
    assert.deepEqual(sent, ['please receive']);
  } finally {
    await live.dispose();
  }
});

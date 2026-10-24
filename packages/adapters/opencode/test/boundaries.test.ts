// The last word of a prompt: Newline and Enter end it like a space (real-host
// round 4: `please recieve` was sent as typed on every host).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testInlinePlugin } from '@murmo/core/testing';
import { createInProcessExecutor } from '@murmo/executor';
import { OpenCodeAdapter } from '../src/adapter.ts';
import { startSession } from '../src/session.ts';
import { FakeOpenCode } from './fake-opencode.ts';

async function start() {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  const started = await startSession({
    adapter,
    loadLanguagePack: false,
    executor: createInProcessExecutor(),
    plugins: [testInlinePlugin('autocorrect', { enabled: true })],
  });
  return { host, adapter, started };
}

const ticks = async (n = 4) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** OpenCode's submit runs the pipeline off the key callback; give it turns to finish. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
}

test('Shift+Enter fixes the word before it; Backspace restores the word and the line break', async () => {
  // Catches Newline not being a word boundary on OpenCode.
  const { host, adapter, started } = await start();
  try {
    host.type('please recieve');
    host.press({ name: 'enter', sequence: '\r', shift: true });
    await ticks();
    assert.equal(adapter.getDraft().text, 'please receive\n');
    host.press({ name: 'backspace', sequence: '\x7f' });
    await ticks();
    assert.equal(adapter.getDraft().text, 'please recieve');
  } finally {
    await started.close();
  }
});

test('Enter puts the last-word fix in the box, then submits', async () => {
  // Catches the last word being sent as typed, and a send that differs from the box.
  const { host, started } = await start();
  try {
    const sent: string[] = [];
    host.inbox.push((event) => sent.push(event.item.payload.text));
    host.type('please recieve');
    await ticks();
    host.press({ name: 'return', sequence: '\r' });
    await until(() => sent.length > 0);
    assert.deepEqual(host.dispatched, ['prompt.submit']);
    assert.deepEqual(sent, ['please receive']);
  } finally {
    await started.close();
  }
});

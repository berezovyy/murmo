// Built-in plugins on the adapter: literal shortcuts from settings (r14 H1)
// and a packed test table for `teh `.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testInlinePlugin } from '@murmo/core/testing';
import { createInProcessExecutor } from '@murmo/executor';
import { compileShortcuts, shortcutsPlugin } from '@murmo/plugin-shortcuts';
import { OpenCodeAdapter } from '../src/adapter.ts';
import { startSession } from '../src/session.ts';
import { FakeOpenCode } from './fake-opencode.ts';

const executor = () => createInProcessExecutor({ pressure: () => 1 });

test(';tst space expands from installed shortcut settings (r14 H1)', async () => {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  const compiled = compileShortcuts({
    replacements: [{ shortcut: ';tst', text: 'Run the test suite.', origin: 'user' }],
  });
  const started = await startSession({
    adapter,
    loadLanguagePack: false,
    executor: executor(),
    plugins: [shortcutsPlugin(compiled)],
  });
  host.type(';tst');
  host.press({ name: 'space', sequence: ' ' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(adapter.getDraft().text, 'Run the test suite. ');
  await started.close();
});

test('typed teh plus space becomes the  (test table, burst path)', async () => {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  const started = await startSession({
    adapter,
    loadLanguagePack: false,
    executor: executor(),
    plugins: [testInlinePlugin('autocorrect', { enabled: true })],
  });
  host.type('teh');
  host.press({ name: 'space', sequence: ' ' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(adapter.getDraft().text, 'the ');
  await started.close();
});

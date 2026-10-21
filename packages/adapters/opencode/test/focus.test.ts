// Attach on FOCUSED_EDITOR, re-check per key. No 10/25 ms polling timer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OpenCodeAdapter } from '../src/adapter.ts';
import { FakeOpenCode } from './fake-opencode.ts';

test('FOCUSED_EDITOR attaches the prompt without a polling timer', async () => {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  await adapter.ready();
  host.focusPrompt();
  assert.equal(adapter.editor?.traits.role, 'prompt');
  adapter.dispose();
});

test('tui.ts and plugin.ts never call setInterval (phase 22: no polling)', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const file of ['plugin.ts', 'tui.ts', 'adapter.ts']) {
    const src = readFileSync(join(dir, '../src', file), 'utf8');
    assert.equal(src.includes('setInterval'), false, `${file} must not poll`);
  }
});

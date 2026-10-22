// Display-name checks are a supplement; the real-id prefix is the defence (E7, E10).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectDisplayName } from '../src/index.ts';
import { createHarness, type DirectPluginSpec } from '../src/testing/index.ts';

test('SYSTEM Permission and a Cyrillic look-alike are flagged, rows still use the real id (C names)', async () => {
  const system: DirectPluginSpec = {
    id: 'prompt-tools',
    builtin: false,
    factory: () => ({
      name: 'SYSTEM Permission',
      version: '1',
      permissions: ['draft:read'],
      onChange(change) {
        return [{ type: 'status', text: 'ready', baseVersion: change.draft.version }];
      },
    }),
  };
  const h = await createHarness({ plugins: [system] });
  await h.driver.type('a');
  await h.driver.settle();
  const status = h.adapter.status ?? '';
  assert.match(status, /\[plugin prompt-tools\]/);
  assert.match(h.session?.stats().notices.join(' ') ?? '', /reserved-word/);
  await h.session?.dispose();
});

test('a Cyrillic letter in SYSTEM is mixed-script (E10)', () => {
  // U+0415 CYRILLIC CAPITAL LETTER IE looks like Latin E.
  const flags = inspectDisplayName('SYSTЕM');
  assert.equal(flags.mixedScript, true);
});

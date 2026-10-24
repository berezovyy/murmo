// A plugin installed with `murmo plugin add` runs in the next Pi session, in
// the third-party executor with its reviewed grants; disabled, it does not.
// Pi once loaded only its built-ins, so an installed plugin never ran.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PluginSpec } from '@murmo/api/adapter';
import { sourceExecutor } from '@murmo/core/testing';
import { storeRootsFromEnv } from '@murmo/store/node';
import { installForTest } from '@murmo/store/node/testing';
import { startPiSession } from '../src/session.ts';
import { createFakePi, FakePiEditor, fakeTuiApi } from './fake-pi.ts';

const sendHold = fileURLToPath(new URL('../../../../fixtures/hosts/plugins/send-hold', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'murmo-pi-installed-'));
for (const name of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME']) {
  process.env[name] = join(root, name.toLowerCase());
}
after(() => rmSync(root, { recursive: true, force: true }));

async function sendInNewSession(text: string): Promise<{ sent: string[]; loaded: PluginSpec[]; grants: string[] }> {
  const env = createFakePi();
  const loaded: PluginSpec[] = [];
  const started = await startPiSession({
    Base: FakePiEditor,
    tuiApi: fakeTuiApi,
    ctx: env.ctx,
    pi: env.host,
    version: '1.3.0',
    cwd: root,
    thirdParty: sourceExecutor(loaded),
  });
  try {
    const sent: string[] = [];
    const editor = env.editor;
    const original = editor.onSubmit;
    editor.onSubmit = (value) => {
      sent.push(value);
      original?.(value);
    };
    for (const ch of text) editor.handleInput(ch);
    await started.session.settle();
    editor.handleInput('\r');
    for (let i = 0; i < 200 && sent.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
    return { sent, loaded, grants: [...started.runner.grantOf('send-hold')] };
  } finally {
    await started.dispose();
  }
}

test('an installed plugin runs in the next Pi session with its reviewed grants, and stops once disabled', async () => {
  const roots = storeRootsFromEnv();
  installForTest(roots, sendHold, { grants: ['draft:read', 'submit'] });
  const held = await sendInNewSession('fix zzhold');
  assert.deepEqual(
    held.loaded.map((spec) => [spec.id, spec.sandbox]),
    [['send-hold', true]],
    'loaded in the third-party executor',
  );
  assert.deepEqual(held.grants, ['draft:read', 'submit']);
  assert.deepEqual(held.sent, [], 'the plugin held the send');

  installForTest(roots, sendHold, { grants: ['draft:read', 'submit'], enabled: false });
  const free = await sendInNewSession('fix zzhold');
  assert.deepEqual(free.loaded, []);
  assert.deepEqual(free.sent, ['fix zzhold']);
});

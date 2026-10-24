// A plugin installed with `murmo plugin add` runs in the next OpenCode
// session, in the third-party executor with its reviewed grants; disabled,
// it does not. OpenCode once loaded only its built-ins.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PluginSpec } from '@murmo/api/adapter';
import { sourceExecutor } from '@murmo/core/testing';
import { pluginRecordPath, storeLayout } from '@murmo/store';
import { listLiveSessions, storeRootsFromEnv, waitForRevision } from '@murmo/store/node';
import { installForTest } from '@murmo/store/node/testing';
import { OpenCodeAdapter } from '../src/adapter.ts';
import { startSession } from '../src/session.ts';
import { FakeOpenCode } from './fake-opencode.ts';

const sendHold = fileURLToPath(new URL('../../../../fixtures/hosts/plugins/send-hold', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'murmo-opencode-installed-'));
const env = { ...process.env, XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state') };
after(() => rmSync(root, { recursive: true, force: true }));

async function sendInNewSession(text: string) {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  const loaded: PluginSpec[] = [];
  const started = await startSession({ adapter, env, loadLanguagePack: false, thirdParty: sourceExecutor(loaded) });
  try {
    host.type(text);
    await started.session.settle();
    host.press({ name: 'return', sequence: '\r' });
    for (let i = 0; i < 200 && !host.dispatched.length; i++) await new Promise((resolve) => setImmediate(resolve));
    return { loaded, sent: host.dispatched.includes('prompt.submit'), draft: adapter.getDraft().text };
  } finally {
    await started.close();
  }
}

test('an installed plugin runs in the next OpenCode session, and stops once disabled', async () => {
  installForTest(storeRootsFromEnv(env), sendHold, { grants: ['draft:read', 'submit'] });
  const held = await sendInNewSession('fix zzhold');
  assert.deepEqual(
    held.loaded.map((spec) => [spec.id, spec.sandbox]),
    [['send-hold', true]],
  );
  assert.equal(held.sent, false, 'the plugin held the send');
  assert.equal(held.draft, 'fix zzhold');
  // Its storage lived in memory and was gone when OpenCode quit.
  const path = pluginRecordPath(storeLayout(storeRootsFromEnv(env)), 'send-hold');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual([record.plugin, record.data], ['send-hold', { lastHeld: 'fix zzhold' }]);

  installForTest(storeRootsFromEnv(env), sendHold, { grants: ['draft:read', 'submit'], enabled: false });
  const free = await sendInNewSession('fix zzhold');
  assert.deepEqual(free.loaded, []);
  assert.equal(free.sent, true);
});

test('plugin add and disable apply to an open OpenCode session, which acknowledges each revision', async () => {
  // A running session never looked at plugins.json again: an added plugin
  // did nothing and a disabled one kept running until OpenCode restarted.
  const roots = storeRootsFromEnv(env);
  rmSync(roots.data, { recursive: true, force: true });
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  const loaded: PluginSpec[] = [];
  const started = await startSession({ adapter, env, loadLanguagePack: false, thirdParty: sourceExecutor(loaded) });
  const send = async (text: string) => {
    host.dispatched.length = 0;
    host.type(text);
    await started.session.settle();
    host.press({ name: 'return', sequence: '\r' });
    for (let i = 0; i < 200 && !host.dispatched.length; i++) await new Promise((resolve) => setImmediate(resolve));
    return host.dispatched.includes('prompt.submit');
  };
  try {
    installForTest(roots, sendHold, { grants: ['draft:read', 'submit'] });
    await waitForRevision(roots, 1, 3000);
    assert.equal(await send('fix zzhold'), false, 'the plugin added mid-session held the send');
    assert.deepEqual(
      loaded.map((spec) => spec.id),
      ['send-hold'],
    );
    installForTest(roots, sendHold, { grants: ['draft:read', 'submit'], enabled: false });
    await waitForRevision(roots, 2, 3000);
    assert.equal(await send(''), true, 'the plugin disabled mid-session let it go');
  } finally {
    await started.close();
  }
  assert.deepEqual(await listLiveSessions(roots), [], 'a closed session leaves no acknowledgement to wait on');
});

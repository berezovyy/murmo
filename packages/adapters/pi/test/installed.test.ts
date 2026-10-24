// A plugin installed with `murmo plugin add` runs in the next Pi session, in
// the third-party executor with its reviewed grants; disabled, it does not.
// Pi once loaded only its built-ins, so an installed plugin never ran.
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
import { startPiSession } from '../src/session.ts';
import { createFakePi, FakePiEditor, fakeTuiApi } from './fake-pi.ts';

const sendHold = fileURLToPath(new URL('../../../../fixtures/hosts/plugins/send-hold', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'murmo-pi-installed-'));
for (const name of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME']) {
  process.env[name] = join(root, name.toLowerCase());
}
after(() => rmSync(root, { recursive: true, force: true }));

/** Waits for Enter's outcome, a send or a block, on the clock: counting event
 *  loop turns ran out under a loaded parallel run before the plugin answered. */
async function decided(session: { stats(): { blocked: number } }, sent: string[], before: number): Promise<void> {
  const blocked = session.stats().blocked;
  const deadline = Date.now() + 5000;
  while (sent.length === before && session.stats().blocked === blocked) {
    if (Date.now() > deadline) throw new Error('Enter was neither sent nor blocked within 5 s');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
    const outcome = decided(started.session, sent, 0);
    editor.handleInput('\r');
    await outcome;
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
  // Its storage was in a folder `murmo plugin` never reads, so an update's
  // migration and a rollback's snapshot missed it.
  const record = JSON.parse(readFileSync(pluginRecordPath(storeLayout(roots), 'send-hold'), 'utf8'));
  assert.deepEqual([record.plugin, record.data], ['send-hold', { lastHeld: 'fix zzhold' }]);

  installForTest(roots, sendHold, { grants: ['draft:read', 'submit'], enabled: false });
  const free = await sendInNewSession('fix zzhold');
  assert.deepEqual(free.loaded, []);
  assert.deepEqual(free.sent, ['fix zzhold']);
});

test('plugin add and disable apply to an open Pi session, which acknowledges each revision', async () => {
  // A running session never looked at plugins.json again: an added plugin
  // did nothing and a disabled one kept running until Pi restarted, and the
  // CLI had no session acknowledgement to wait for before swapping files.
  const roots = storeRootsFromEnv();
  rmSync(roots.data, { recursive: true, force: true });
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
  const sent: string[] = [];
  const editor = env.editor;
  const original = editor.onSubmit;
  editor.onSubmit = (value) => {
    sent.push(value);
    original?.(value);
  };
  const send = async (text: string) => {
    for (const ch of text) editor.handleInput(ch);
    await started.session.settle();
    const outcome = decided(started.session, sent, sent.length);
    editor.handleInput('\r');
    await outcome;
    editor.setText('');
  };
  try {
    installForTest(roots, sendHold, { grants: ['draft:read', 'submit'] });
    await waitForRevision(roots, 1, 3000);
    await send('fix zzhold');
    assert.deepEqual(sent, [], 'the plugin added mid-session held the send');
    assert.deepEqual(
      loaded.map((spec) => spec.id),
      ['send-hold'],
    );

    installForTest(roots, sendHold, { grants: ['draft:read', 'submit'], enabled: false });
    await waitForRevision(roots, 2, 3000);
    await send('fix zzhold');
    assert.deepEqual(sent, ['fix zzhold'], 'the plugin disabled mid-session let it go');
    const [live] = await listLiveSessions(roots);
    assert.equal(live?.ack.host, 'pi');
  } finally {
    await started.dispose();
  }
  assert.deepEqual(await listLiveSessions(roots), [], 'a closed session leaves no acknowledgement to wait on');
});

test('an installed plugin gets only the permissions the user granted, never a declared default', async () => {
  // A permission granted by default when declared (submit, draft:write) was
  // granted to an installed plugin even when the user left it out at review
  // or took it back with `murmo plugin revoke-grant`.
  const roots = storeRootsFromEnv();
  rmSync(roots.data, { recursive: true, force: true });
  installForTest(roots, sendHold, { grants: ['draft:read'] });
  const result = await sendInNewSession('fix zzhold');
  assert.deepEqual(result.grants, ['draft:read']);
  assert.deepEqual(result.sent, ['fix zzhold'], 'without submit the plugin cannot hold a send');
});

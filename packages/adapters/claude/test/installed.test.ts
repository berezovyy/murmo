// A plugin installed with `murmo plugin add` runs in the next Claude Code
// session, through the helper with its reviewed grants; disabled, it does
// not. Claude once loaded only its built-ins.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PluginSpec } from '@murmo/api/adapter';
import { sourceExecutor } from '@murmo/core/testing';
import { readPluginSelection } from '@murmo/store';
import { installForTest, type TestInstall } from '@murmo/store/node/testing';
import { debugHost, register, resetHost } from '../src/register.ts';
import { createClaudeHost } from '../src/session.ts';
import { type } from './boot.ts';
import { FakeClaude, submitNext } from './fake-runtime.ts';

const sendHold = fileURLToPath(new URL('../../../../fixtures/hosts/plugins/send-hold', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'murmo-claude-installed-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The store files `murmo plugin add` leaves, at the paths the fake Claude serves (`/data/murmo/...`). */
function installedFiles(options: TestInstall): Record<string, Uint8Array> {
  const data = mkdtempSync(join(scratch, 'data-'));
  installForTest({ data }, sendHold, options);
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[`/data/murmo/${relative(data, path)}`] = readFileSync(path);
    }
  };
  walk(data);
  return files;
}

async function sendInNewSession(options: TestInstall) {
  const fake = new FakeClaude({ files: installedFiles(options) });
  const installed = await readPluginSelection({ data: '/data/murmo' }, async (path) =>
    fake.files.has(path) ? (fake.files.get(path) as Uint8Array) : undefined,
  );
  const loaded: PluginSpec[] = [];
  const host = createClaudeHost({ skipProbes: true, thirdParty: sourceExecutor(loaded) });
  await host.bootPacked({ payloadRoot: '', integrityJson: '{}', cwd: '/project', installed });
  try {
    await type(host, fake, 'fix zzhold');
    const result = await host.adapter.handleSubmit({ text: fake.draft.text }, submitNext(fake));
    return { loaded, sent: [...fake.sent], dropped: result.drop };
  } finally {
    await host.dispose();
  }
}

test('an installed plugin runs in the next Claude session through the third-party executor, and stops once disabled', async () => {
  const held = await sendInNewSession({ grants: ['draft:read', 'submit'] });
  assert.deepEqual(
    held.loaded.map((spec) => [spec.id, spec.sandbox]),
    [['send-hold', true]],
  );
  assert.deepEqual(held.sent, [], 'the plugin held the send');
  assert.ok(held.dropped);

  const free = await sendInNewSession({ grants: ['draft:read', 'submit'], enabled: false });
  assert.deepEqual(free.loaded, []);
  assert.deepEqual(free.sent, ['fix zzhold']);
});

test('session.start reads the installed plugins through Claude file API and needs the helper to run them', async () => {
  // Catches register never reading plugins.json, and a third-party plugin
  // falling back to running in Claude's own process when there is no helper.
  resetHost();
  const fake = new FakeClaude({ files: installedFiles({ grants: ['draft:read', 'submit'] }) });
  register(fake.on);
  const start = fake.hooks.get('session.start')?.[0]?.handler as (
    $: unknown,
    event: unknown,
    next: (event: unknown) => unknown,
  ) => Promise<unknown>;
  await start(fake.$, {}, (event) => event);
  const host = debugHost();
  assert.ok(host?.alive);
  const notices = host.session?.stats().notices ?? [];
  assert.ok(
    notices.includes(
      'Plugin send-hold did not start: third-party plugins need the isolated plugin host: the Murmo helper is not running (murmo doctor)',
    ),
    JSON.stringify(notices),
  );
  await host.dispose();
  resetHost();
});

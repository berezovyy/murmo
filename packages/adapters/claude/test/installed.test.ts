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
import { parsePluginsManifest, pluginsManifestPath, readPluginSelection } from '@murmo/store';
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
  try {
    assert.ok(host?.alive);
    const notices = host.session?.stats().notices ?? [];
    assert.ok(
      notices.includes(
        'Plugin send-hold did not start: third-party plugins need the isolated plugin host: the Murmo helper is not running (murmo doctor)',
      ),
      JSON.stringify(notices),
    );
    // Claude shows one line: it was the startup summary, and the reason the
    // installed plugin was off never reached the screen.
    assert.match(host.adapter.statusLine(), /^Plugin send-hold did not start: /);
  } finally {
    resetHost();
  }
});

test('plugin add and disable apply to an open Claude session', async () => {
  // A running session read plugins.json once at session.start: an added
  // plugin did nothing and a disabled one kept running until Claude restarted.
  const data = mkdtempSync(join(scratch, 'live-'));
  const fake = new FakeClaude({ files: {} });
  const publish = (options: TestInstall) => {
    installForTest({ data }, sendHold, options);
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else fake.files.set(`/data/murmo/${relative(data, path)}`, readFileSync(path));
      }
    };
    walk(data);
  };
  const read = async (path: string) => fake.files.get(path);
  const roots = { data: '/data/murmo' };
  const loaded: PluginSpec[] = [];
  const host = createClaudeHost({ skipProbes: true, thirdParty: sourceExecutor(loaded), recheckMs: 5 });
  await host.bootPacked({
    payloadRoot: '',
    integrityJson: '{}',
    cwd: '/project',
    installed: await readPluginSelection(roots, read),
    services: {
      after: (ms, callback) => {
        const id = setTimeout(callback, ms);
        return { cancel: () => clearTimeout(id) };
      },
      spawn: () => {
        throw new Error('no helper in this test');
      },
      fetch: () => Promise.reject(new Error('no helper in this test')),
      repaint() {},
      suggest: async () => ({ isShown: false }),
    },
    selection: {
      revision: async () => parsePluginsManifest(await read(pluginsManifestPath(roots)))?.revision ?? 0,
      read: () => readPluginSelection(roots, read),
    },
  });
  const until = async (what: string, ready: () => boolean) => {
    for (let i = 0; i < 500 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(ready(), what);
  };
  const runs = () => host.session?.stats().plugins.some((p) => p.id === 'send-hold' && !p.disabled) ?? false;
  try {
    publish({ grants: ['draft:read', 'submit'] });
    await until('send-hold to start', runs);
    await type(host, fake, 'fix zzhold');
    const held = await host.adapter.handleSubmit({ text: fake.draft.text }, submitNext(fake));
    assert.ok(held.drop, 'the plugin added mid-session held the send');

    publish({ grants: ['draft:read', 'submit'], enabled: false });
    await until('send-hold to stop', () => !runs());
    await host.adapter.handleSubmit({ text: fake.draft.text }, submitNext(fake));
    assert.deepEqual(fake.sent, ['fix zzhold'], 'the plugin disabled mid-session let it go');
  } finally {
    await host.dispose();
  }
});

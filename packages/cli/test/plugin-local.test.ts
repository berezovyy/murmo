// The local authoring loop: `plugin new`, edit, `plugin add ./folder` (or
// `plugin pack`, then add the archive), with a review of what it asks for.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { pluginNew } from '@murmo/devkit';
import { SANDBOX_UNAVAILABLE } from '@murmo/executor';
import { readLedger, readPluginsManifest } from '@murmo/store/node';
import { main } from '../src/cli.ts';
import { type PluginCommandContext, pluginCommand } from '../src/plugin/commands.ts';
import { describeError } from '../src/plugin/errors.ts';
import { capture, makeHome, type PluginHome, preparedHome } from './helpers.ts';

async function run(
  home: PluginHome,
  args: readonly string[],
  answers: readonly string[] = [],
): Promise<{ code: number; out: string; err: string; asked: string[] }> {
  const asked: string[] = [];
  const queue = [...answers];
  const ctx: PluginCommandContext = {
    ...home.ctx,
    ask: async (prompt) => {
      asked.push(prompt);
      return queue.shift() ?? '';
    },
  };
  home.stdout.length = 0;
  home.stderr.length = 0;
  let code: number;
  try {
    code = await pluginCommand(ctx, args);
  } catch (error) {
    home.stderr.push(describeError(error));
    code = 1;
  }
  return { code, out: home.stdout.join(''), err: home.stderr.join(''), asked };
}

test('new, edit, add ./folder: installed after one review, signed with the local development key', async () => {
  // `plugin add ./hello` was EISDIR, `new` wrote murmo.plugin.json while add
  // wanted a signed murmo.json envelope, and there was no pack or sign step.
  const home = await preparedHome();
  try {
    const folder = await pluginNew('hello', home.dir);
    const added = await run(home, ['add', folder], ['y']);
    assert.equal(added.code, 0, added.err);
    assert.equal(added.asked.length, 1);
    assert.match(added.out, /hello@0\.1\.0 from .*hello \(a local folder\)/);
    assert.match(added.out, /draft:read: Count characters in the current draft\./);
    assert.match(added.out, /your local development key [0-9a-f]{12}/);
    assert.match(added.out, /added hello@0\.1\.0, granted draft:read/);
    const manifest = await readPluginsManifest(home.roots);
    const installed = manifest?.plugins.hello;
    assert.deepEqual(installed?.grants, ['draft:read']);
    assert.equal(installed?.distribution?.source.kind, 'folder');
    const ledger = await readLedger(home.roots);
    assert.equal(ledger.identities.hello?.publisher, ledger.localPublisher);

    // Edit and update without bumping the version: the loop an author repeats.
    const entry = join(folder, 'plugin.mjs');
    writeFileSync(entry, readFileSync(entry, 'utf8').replace("' chars'", "' characters'"));
    const updated = await run(home, ['update', folder]);
    assert.equal(updated.code, 0, updated.err);
    assert.equal(updated.asked.length, 0, 'the same permissions need no second review');
    const after = await readPluginsManifest(home.roots);
    assert.notEqual(after?.plugins.hello?.distribution?.digest, installed?.distribution?.digest);
    assert.match((await run(home, ['update', folder])).out, /unchanged hello/);
  } finally {
    home.remove();
  }
});

test('declining the review installs nothing and leaves no files behind', async () => {
  // Catches a refused add that still wrote extensions/<id> or trust.
  const home = await preparedHome();
  try {
    const folder = await pluginNew('hello', home.dir);
    const declined = await run(home, ['add', folder], ['n']);
    assert.equal(declined.code, 1);
    assert.match(declined.err, /hello asks for permissions you have not granted/);
    assert.match(declined.err, /draft:read: Count characters in the current draft\./);
    assert.match(declined.err, /--grant draft:read/);
    assert.equal((await readPluginsManifest(home.roots))?.plugins.hello, undefined);
    assert.equal((await readLedger(home.roots)).identities.hello, undefined);
    assert.equal(existsSync(join(home.roots.data, 'extensions', 'hello')), false);
    // Non-interactive: --grant is the approval.
    assert.equal((await run(home, ['add', folder, '--grant', 'draft:read'])).code, 0);
  } finally {
    home.remove();
  }
});

test('pack a folder with your own key, then add the archive with that public key', async () => {
  // The way to share a plugin: a signed archive others add with --trust-key.
  const home = await preparedHome();
  try {
    const folder = await pluginNew('hello', home.dir);
    const pair = generateKeyPairSync('ed25519');
    const key = join(home.dir, 'publisher.pem');
    const pub = join(home.dir, 'publisher.pub');
    writeFileSync(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(pub, pair.publicKey.export({ type: 'spki', format: 'pem' }));
    const out = join(home.dir, 'hello.tgz');
    const packed = await run(home, ['pack', folder, '--key', key, '--out', out]);
    assert.equal(packed.code, 0, packed.err);
    assert.match(packed.out, /packed hello@0\.1\.0/);
    const added = await run(home, ['add', out, '--trust-key', pub, '--grant', 'draft:read']);
    assert.equal(added.code, 0, added.err);
    const review = await run(home, ['inspect', out]);
    assert.match(
      review.out,
      /^ {2}draft:read: Count characters in the current draft\.$/m,
      'reason without the name doubled',
    );
  } finally {
    home.remove();
  }
});

test('a plugin whose code disagrees with its manifest says which file and which values', async () => {
  // A syntax error printed only "Unexpected end of input"; a name mismatch
  // only "descriptor-version-mismatch", with no expected or actual values.
  const home = await preparedHome();
  try {
    const folder = await pluginNew('hello', home.dir);
    const entry = join(folder, 'plugin.mjs');
    const good = readFileSync(entry, 'utf8');
    writeFileSync(entry, good.replace('name: "hello"', 'name: "hullo"'));
    const renamed = await run(home, ['add', folder, '--grant', 'draft:read']);
    assert.equal(renamed.code, 1);
    assert.match(
      renamed.err,
      /plugin\.mjs returns name hullo, version 0\.1\.0; murmo\.plugin\.json says hello, 0\.1\.0/,
    );
    writeFileSync(entry, good.slice(0, good.length - 6));
    const broken = await run(home, ['add', folder, '--grant', 'draft:read']);
    assert.equal(broken.code, 1);
    assert.match(broken.err, /could not load plugin\.mjs: .*plugin\.mjs:\d+/);
  } finally {
    home.remove();
  }
});

test('the CLI prints what an approval error needs, not only its code', async () => {
  // `murmo plugin add` printed `permission-approval-required` with no plugin,
  // permission or reason, and `publisher-approval-required` without the key.
  const t = makeHome('murmo-plugin-errors-');
  try {
    const folder = await pluginNew('hello', t.root);
    const io = capture();
    const pack = await main(['plugin', 'pack', folder, '--out', join(t.root, 'hello.tgz')], {
      env: t.env,
      cwd: t.root,
      out: io.writeOut,
      err: io.writeErr,
    });
    assert.equal(pack, 0, io.err.join(''));
    const add = await main(['plugin', 'add', join(t.root, 'hello.tgz')], {
      env: t.env,
      cwd: t.root,
      out: io.writeOut,
      err: io.writeErr,
      ask: async () => '',
    });
    assert.equal(add, 1);
    const err = io.err.join('');
    assert.match(err, /hello is signed by publisher [0-9a-f]{64}/);
    assert.match(err, /--trust-key/);
  } finally {
    t.remove();
  }
});

test('plugin add never runs the plugin in its own process: hostile code cannot touch files or sockets', async () => {
  // Preflight imported the plugin into the CLI's Node process, so its
  // top-level code and activate() ran with the user's full file system and
  // network before any review mattered.
  const home = await preparedHome();
  const listener = createServer((socket) => socket.end());
  const socketPath = join(home.dir, 'hostile.sock');
  let connections = 0;
  listener.on('connection', () => {
    connections++;
  });
  await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
  try {
    const folder = await pluginNew('hello', home.dir);
    const entry = join(folder, 'plugin.mjs');
    const canary = join(home.dir, 'canary');
    const attempts = (label: string) => `
  try { (await import('node:fs')).writeFileSync(${JSON.stringify(`${canary}-${label}-fs`)}, 'x'); } catch {}
  try { (await import('node:child_process')).execFileSync('/usr/bin/touch', [${JSON.stringify(`${canary}-${label}-spawn`)}]); } catch {}
  try {
    const net = await import('node:net');
    await new Promise((done) => { const s = net.connect(${JSON.stringify(socketPath)}, done); s.on('error', done); });
  } catch {}`;
    writeFileSync(
      entry,
      `${attempts('top')}
export default () => ({
  name: 'hello',
  version: '0.1.0',
  permissions: ['draft:read'],
  async activate() {${attempts('activate')}
    return [];
  },
});
`,
    );
    const added = await run(home, ['add', folder, '--grant', 'draft:read']);
    assert.equal(added.code, 0, added.err);
    for (const label of ['top', 'activate']) {
      for (const kind of ['fs', 'spawn'])
        assert.equal(existsSync(`${canary}-${label}-${kind}`), false, `${label} ${kind}`);
    }
    assert.equal(connections, 0, 'the plugin reached a local socket');
  } finally {
    listener.close();
    home.remove();
  }
});

test('the real CLI preflights a plugin inside the OS sandbox the hosts use', async () => {
  // Without a stand-in, add must ask the helper for the third-party sandbox.
  // Inside the macOS offline runner that sandbox is refused (no nesting), so
  // the refusal proves it was asked for, and the user reads why, not a crash.
  const t = makeHome('murmo-plugin-sandboxed-');
  try {
    const folder = await pluginNew('hello', t.root);
    const io = capture();
    const add = await main(['plugin', 'add', folder, '--grant', 'draft:read'], {
      env: t.env,
      cwd: t.root,
      out: io.writeOut,
      err: io.writeErr,
    });
    const err = io.err.join('');
    if (process.platform === 'darwin' && process.env.MURMO_OFFLINE === '1') {
      assert.equal(add, 1, io.out.join(''));
      assert.match(err, new RegExp(`could not load plugin\\.mjs: ${SANDBOX_UNAVAILABLE}`));
    } else {
      assert.ok(add === 0 || err.includes(SANDBOX_UNAVAILABLE), err);
    }
  } finally {
    t.remove();
  }
});

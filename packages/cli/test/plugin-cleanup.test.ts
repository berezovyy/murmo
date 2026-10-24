// What add, update and remove leave behind, publisher key changes, and
// taking back one grant.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pluginsManifestPath } from '@murmo/store';
import { readLedger, readPluginsManifest } from '@murmo/store/node';
import { describeError } from '../src/plugin/errors.ts';
import { generatePublisher, packPlugin, preparedHome, runPlugin, writeKey } from './helpers.ts';

type Home = Awaited<ReturnType<typeof preparedHome>>;

async function run(home: Home, args: string[]): Promise<{ code: number; out: string; err: string }> {
  home.stdout.length = 0;
  home.stderr.length = 0;
  let code: number;
  try {
    const { pluginCommand } = await import('../src/plugin/commands.ts');
    code = await pluginCommand(home.ctx, args);
  } catch (error) {
    home.stderr.push(describeError(error));
    code = 1;
  }
  return { code, out: home.stdout.join(''), err: home.stderr.join('') };
}

function archive(home: Home, name: string, options: Parameters<typeof packPlugin>[0]) {
  const packed = packPlugin(options);
  const tgz = join(home.dir, name);
  writeFileSync(tgz, packed.bytes);
  return { packed, tgz, key: writeKey(home.dir, packed.publicPem, `${name}.pub`) };
}

test('a first add that fails leaves no plugin folders and no trust behind', async () => {
  // A failed add left extensions/<id>/ (and its cache and storage parents).
  const home = await preparedHome();
  try {
    const broken = archive(home, 'broken.tgz', { source: 'export default () => { throw new Error("boom"); };\n' });
    assert.equal(await runPlugin(home, ['add', broken.tgz, '--trust-key', broken.key, '--grant', 'draft:read']), 1);
    for (const tree of ['extensions', 'plugin-cache', 'plugin-storage']) {
      assert.equal(existsSync(join(home.roots.data, tree, 'dist-demo')), false, `${tree}/dist-demo left behind`);
    }
    assert.equal((await readLedger(home.roots)).identities['dist-demo'], undefined);
  } finally {
    home.remove();
  }
});

test('a new key without a rotation statement is refused, naming both keys, until the user replaces the publisher', async () => {
  // `update --trust-key NEW` accepted a different publisher with no rotation
  // statement, and publisher-key-changed showed no fingerprints.
  const home = await preparedHome();
  try {
    const first = archive(home, 'v1.tgz', { sequence: 1 });
    assert.equal(await runPlugin(home, ['add', first.tgz, '--trust-key', first.key, '--grant', 'draft:read']), 0);
    const other = generatePublisher();
    const next = archive(home, 'v2.tgz', {
      privateKey: other.privateKey,
      publisherPem: other.publicPem,
      version: '1.1.0',
      sequence: 2,
    });
    const refused = await run(home, ['update', next.tgz, '--trust-key', next.key]);
    assert.equal(refused.code, 1);
    assert.ok(refused.err.includes(first.packed.publisher), refused.err);
    assert.ok(refused.err.includes(other.fingerprint), refused.err);
    assert.match(refused.err, /--replace-publisher/);
    assert.equal((await readLedger(home.roots)).identities['dist-demo']?.publisher, first.packed.publisher);

    const replaced = await run(home, ['update', next.tgz, '--trust-key', next.key, '--replace-publisher']);
    assert.equal(replaced.code, 0, replaced.err);
    const identity = (await readLedger(home.roots)).identities['dist-demo'];
    assert.equal(identity?.publisher, other.fingerprint);
    assert.ok(identity?.chain?.includes(first.packed.publisher), 'the old key stays in the chain');
  } finally {
    home.remove();
  }
});

test('remove says the publisher pin stays and why', async () => {
  // The text output said only `removed <id>`; the pin it keeps is what
  // refuses a downgrade or a different key on a later add.
  const home = await preparedHome();
  try {
    const first = archive(home, 'v1.tgz', {});
    assert.equal(await runPlugin(home, ['add', first.tgz, '--trust-key', first.key, '--grant', 'draft:read']), 0);
    const removed = await run(home, ['remove', 'dist-demo']);
    assert.equal(removed.code, 0);
    assert.match(removed.out, /removed dist-demo/);
    assert.match(removed.out, /kept its publisher key and highest version/);
  } finally {
    home.remove();
  }
});

test('one grant can be taken back and given again without removing the plugin', async () => {
  // There was no way to drop a permission short of `remove`.
  const home = await preparedHome();
  try {
    const publisher = generatePublisher();
    const signed = { privateKey: publisher.privateKey, publisherPem: publisher.publicPem };
    const first = archive(home, 'v1.tgz', { ...signed, permissions: ['draft:read', 'draft:write'] });
    assert.equal(
      await runPlugin(home, ['add', first.tgz, '--trust-key', first.key, '--grant', 'draft:read,draft:write']),
      0,
    );
    const revoked = await run(home, ['revoke-grant', 'dist-demo', 'draft:write']);
    assert.equal(revoked.code, 0, revoked.err);
    assert.match(revoked.out, /dist-demo keeps draft:read; open sessions apply it now/);
    assert.deepEqual((await readPluginsManifest(home.roots))?.plugins['dist-demo']?.grants, ['draft:read']);

    // An update keeps it off and does not ask again.
    const v2 = archive(home, 'v2.tgz', {
      ...signed,
      permissions: ['draft:read', 'draft:write'],
      version: '1.0.1',
      sequence: 2,
    });
    const updated = await run(home, ['update', v2.tgz]);
    assert.equal(updated.code, 0, updated.err);
    assert.deepEqual((await readPluginsManifest(home.roots))?.plugins['dist-demo']?.grants, ['draft:read']);

    const undeclared = await run(home, ['grant', 'dist-demo', 'network']);
    assert.equal(undeclared.code, 1);
    assert.match(undeclared.err, /does not declare network/);
    assert.equal((await run(home, ['grant', 'dist-demo', 'draft:write'])).code, 0);
    assert.deepEqual((await readPluginsManifest(home.roots))?.plugins['dist-demo']?.grants, [
      'draft:read',
      'draft:write',
    ]);
  } finally {
    home.remove();
  }
});

test('a plugin list written before a built-in existed still lists it and can turn it off', async () => {
  // Stores set up before `names` shipped have no entry for it, so it was
  // missing from `plugin list` and `plugin disable names` had nothing to change.
  const home = await preparedHome();
  try {
    const path = pluginsManifestPath(home.roots);
    const old = JSON.parse(readFileSync(path, 'utf8'));
    delete old.plugins.names;
    old.order = old.order.filter((id: string) => id !== 'names');
    writeFileSync(path, JSON.stringify(old));
    const list = await run(home, ['list']);
    assert.equal(list.code, 0, list.err);
    assert.match(list.out, /names/);
    const off = await run(home, ['disable', 'names']);
    assert.equal(off.code, 0, off.err);
    const after = await readPluginsManifest(home.roots);
    assert.equal(after?.plugins.names?.enabled, false);
    assert.equal(after?.order.at(-1), 'names');
  } finally {
    home.remove();
  }
});

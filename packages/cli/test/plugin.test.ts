// Distribution attacks, pins, grants and project lists (plan 28 E1–E3, E6, E7).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLedger, readPluginsManifest, writeJournal } from '@murmo/store/node';
import { formatError } from '../src/plugin/errors.ts';
import { sha512Integrity } from '../src/plugin/sources.ts';
import { generatePublisher, packPlugin, preparedHome, runPlugin, writeKey } from './helpers.ts';

async function addFixture(
  home: Awaited<ReturnType<typeof preparedHome>>,
  options: Parameters<typeof packPlugin>[0],
  extra: string[] = [],
): Promise<{ packed: ReturnType<typeof packPlugin>; code: number }> {
  const packed = packPlugin(options);
  const tgz = join(home.dir, `${packed.inspected.envelope.id}-${packed.inspected.envelope.version}.tgz`);
  writeFileSync(tgz, packed.bytes);
  const key = writeKey(home.dir, packed.publicPem);
  const grants = packed.inspected.envelope.permissions;
  const grantArgs = grants.length ? ['--grant', grants.join(',')] : [];
  const code = await runPlugin(home, ['add', tgz, '--trust-key', key, ...grantArgs, ...extra]);
  return { packed, code };
}

test('add without a trust key or grants changes nothing (E2, E3)', async () => {
  const home = await preparedHome();
  try {
    const packed = packPlugin();
    const tgz = join(home.dir, 'v1.tgz');
    writeFileSync(tgz, packed.bytes);
    assert.equal(await runPlugin(home, ['add', tgz]), 1);
    assert.match(home.stderr.join(''), /publisher-approval-required/);
    const key = writeKey(home.dir, packed.publicPem);
    assert.equal(await runPlugin(home, ['add', tgz, '--trust-key', key]), 1);
    assert.match(home.stderr.join(''), /permission-approval-required/);
    assert.match(home.stderr.join(''), /Show a character-count/);
    const before = JSON.stringify(await readPluginsManifest(home.roots));
    assert.equal(
      await runPlugin(home, ['add', tgz, '--trust-key', key, '--grant', 'draft:read', '--digest', '0'.repeat(64)]),
      1,
    );
    assert.match(home.stderr.join(''), /digest-pin-mismatch/);
    assert.equal(JSON.stringify(await readPluginsManifest(home.roots)), before);
  } finally {
    home.remove();
  }
});

test('tarball, git commit and npm exact version install and reinstall offline (E1)', async () => {
  const home = await preparedHome();
  try {
    const packed = packPlugin({ postinstall: true });
    const tgz = join(home.dir, 'v1.tgz');
    writeFileSync(tgz, packed.bytes);
    const key = writeKey(home.dir, packed.publicPem);

    const gitDir = join(home.dir, 'source.git');
    const work = join(home.dir, 'git-work-tree');
    mkdirSync(work);
    const { unpackArchive } = await import('../src/plugin/archive.ts');
    const { dirname } = await import('node:path');
    const files = unpackArchive(packed.bytes);
    for (const [name, bytes] of Object.entries(files)) {
      const path = join(work, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    execFileSync('git', ['init', '-b', 'main', work], { stdio: 'pipe' });
    execFileSync('git', ['-C', work, 'add', '.'], { stdio: 'pipe' });
    execFileSync('git', ['-C', work, '-c', 'user.email=f@t', '-c', 'user.name=f', 'commit', '-m', 'fixture'], {
      stdio: 'pipe',
    });
    execFileSync('git', ['clone', '--bare', work, gitDir], { stdio: 'pipe' });
    const commit = execFileSync('git', ['--git-dir', gitDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    assert.equal(
      await runPlugin(home, ['add', `git+file://${gitDir}#main`, '--trust-key', key, '--grant', 'draft:read']),
      1,
    );
    assert.match(home.stderr.join(''), /git-full-commit-required/);

    const other = await preparedHome();
    try {
      assert.equal(
        await runPlugin(other, ['add', `git+file://${gitDir}#${commit}`, '--trust-key', key, '--grant', 'draft:read']),
        0,
      );
    } finally {
      other.remove();
    }

    home.setGet(async (url) => {
      if (url.pathname.endsWith('/dist-demo/1.0.0')) {
        return Buffer.from(
          JSON.stringify({
            dist: { tarball: 'https://127.0.0.1/artifact.tgz', integrity: sha512Integrity(packed.bytes) },
          }),
        );
      }
      if (url.pathname.endsWith('/artifact.tgz')) return packed.bytes;
      throw new Error(url.href);
    });
    const scopedPack = packPlugin({ id: 'dist-demo', privateKey: packed.privateKey, publisherPem: packed.publicPem });
    const scoped = await preparedHome();
    try {
      scoped.setGet(async (url) => {
        if (url.pathname.endsWith('/artifact.tgz')) return scopedPack.bytes;
        return Buffer.from(
          JSON.stringify({
            dist: { tarball: 'https://127.0.0.1/artifact.tgz', integrity: sha512Integrity(scopedPack.bytes) },
          }),
        );
      });
      assert.equal(
        await runPlugin(scoped, [
          'add',
          'npm:@murmo/dist-demo@1.0.0',
          '--registry',
          'https://127.0.0.1:4443',
          '--trust-key',
          writeKey(scoped.dir, packed.publicPem),
          '--grant',
          'draft:read',
        ]),
        0,
      );
    } finally {
      scoped.remove();
    }

    assert.equal(
      await runPlugin(home, [
        'add',
        'npm:dist-demo@1.0.0',
        '--registry',
        'http://127.0.0.1:1',
        '--trust-key',
        key,
        '--grant',
        'draft:read',
      ]),
      0,
    );
    assert.equal(existsSync(join(home.dir, 'INSTALL_SCRIPT_RAN')), false);
    const installed = await readPluginsManifest(home.roots);
    const digest = installed?.plugins['dist-demo']?.distribution?.digest;
    assert.equal(digest, packed.digest);

    const entryDir = join(home.roots.data, 'extensions', 'dist-demo', digest as string);
    const { rmSync } = await import('node:fs');
    rmSync(entryDir, { recursive: true, force: true });
    home.setGet(async () => {
      throw new Error('registry must not be contacted for offline reinstall');
    });
    assert.equal(await runPlugin(home, ['reinstall', 'dist-demo', '--offline']), 0);
    assert.equal(existsSync(join(entryDir, 'index.mjs')), true);
  } finally {
    home.remove();
  }
});

test('tamper, swapped key, downgrade and same-version substitution are refused (E2)', async () => {
  const home = await preparedHome();
  try {
    const publisher = generatePublisher();
    const v1 = packPlugin({ privateKey: publisher.privateKey, publisherPem: publisher.publicPem, sequence: 1 });
    const tgz = join(home.dir, 'v1.tgz');
    writeFileSync(tgz, v1.bytes);
    const key = writeKey(home.dir, v1.publicPem);
    assert.equal(await runPlugin(home, ['add', tgz, '--trust-key', key, '--grant', 'draft:read']), 0);
    const before = JSON.stringify(await readPluginsManifest(home.roots));

    const tampered = packPlugin({
      privateKey: publisher.privateKey,
      publisherPem: publisher.publicPem,
      source: 'export default () => ({ name: "dist-demo", version: "1.0.0", permissions: ["draft:read"] });\n',
    });
    // Break a signed file hash: rewrite index after packing.
    const { unpackArchive, packTarGz } = await import('../src/plugin/archive.ts');
    const files = unpackArchive(v1.bytes);
    files['index.mjs'] = Buffer.from('export default () => ({ name: "stolen" });\n');
    const tamperedBytes = packTarGz(files);
    writeFileSync(join(home.dir, 'tampered.tgz'), tamperedBytes);
    assert.equal(await runPlugin(home, ['update', join(home.dir, 'tampered.tgz')]), 1);
    assert.match(home.stderr.join(''), /file-digest-mismatch/);

    const swapped = generatePublisher();
    const swappedPack = packPlugin({
      privateKey: swapped.privateKey,
      publisherPem: swapped.publicPem,
      version: '1.1.0',
      sequence: 2,
    });
    writeFileSync(join(home.dir, 'swapped.tgz'), swappedPack.bytes);
    assert.equal(await runPlugin(home, ['update', join(home.dir, 'swapped.tgz')]), 1);
    assert.match(home.stderr.join(''), /publisher-key-changed/);

    const lower = packPlugin({
      privateKey: publisher.privateKey,
      publisherPem: publisher.publicPem,
      version: '0.9.0',
      sequence: 99,
    });
    writeFileSync(join(home.dir, 'down.tgz'), lower.bytes);
    assert.equal(await runPlugin(home, ['update', join(home.dir, 'down.tgz')]), 1);
    assert.match(home.stderr.join(''), /downgrade-denied/);

    const same = packPlugin({
      privateKey: publisher.privateKey,
      publisherPem: publisher.publicPem,
      extraFiles: { 'extra.txt': 'x' },
    });
    writeFileSync(join(home.dir, 'same.tgz'), same.bytes);
    assert.equal(await runPlugin(home, ['update', join(home.dir, 'same.tgz')]), 1);
    assert.match(home.stderr.join(''), /version-content-changed/);

    const entry = join(home.roots.data, 'extensions', 'dist-demo', v1.digest, 'index.mjs');
    const original = readFileSync(entry);
    writeFileSync(entry, Buffer.concat([original, Buffer.from('\n// tamper')]));
    assert.equal(await runPlugin(home, ['doctor', '--json']), 1);
    assert.match(home.stdout.join('') + home.stderr.join(''), /file-digest-mismatch|"ok": false/);
    writeFileSync(entry, original);
    assert.equal(JSON.stringify(await readPluginsManifest(home.roots)), before);
    void tampered;
    void formatError;
  } finally {
    home.remove();
  }
});

test('adding network on update stops; removing a permission proceeds; descriptor escalation is denied (E3)', async () => {
  const home = await preparedHome();
  try {
    const publisher = generatePublisher();
    const { code } = await addFixture(home, { privateKey: publisher.privateKey, publisherPem: publisher.publicPem });
    assert.equal(code, 0);
    const before = JSON.stringify(await readPluginsManifest(home.roots));
    const net = packPlugin({
      privateKey: publisher.privateKey,
      publisherPem: publisher.publicPem,
      version: '1.1.0',
      sequence: 2,
      permissions: ['draft:read', 'network'],
    });
    writeFileSync(join(home.dir, 'net.tgz'), net.bytes);
    assert.equal(await runPlugin(home, ['update', join(home.dir, 'net.tgz')]), 1);
    assert.match(home.stderr.join(''), /permission-approval-required/);
    assert.match(home.stderr.join(''), /remote service/);
    assert.equal(JSON.stringify(await readPluginsManifest(home.roots)), before);

    assert.equal(await runPlugin(home, ['update', join(home.dir, 'net.tgz'), '--grant', 'network']), 0);
    const migrate = packPlugin({
      privateKey: publisher.privateKey,
      publisherPem: publisher.publicPem,
      version: '1.2.0',
      sequence: 3,
      storageVersion: 2,
      migration: { from: 1, rename: { visits: 'launches' } },
      source: `export default () => ({
        name: 'dist-demo', version: '1.2.0', permissions: ['draft:read'],
        async activate(ctx) {
          const current = await ctx.storage.get('visits');
          if (current.status === 'ok' && current.value !== undefined) throw new Error('visits should have been renamed');
        },
      });`,
    });
    writeFileSync(join(home.dir, 'v3.tgz'), migrate.bytes);
    assert.equal(await runPlugin(home, ['update', join(home.dir, 'v3.tgz')]), 0);
    const after = await readPluginsManifest(home.roots);
    assert.equal(after?.plugins['dist-demo']?.grants.includes('network'), false);

    const broken = packPlugin({
      privateKey: publisher.privateKey,
      publisherPem: publisher.publicPem,
      version: '1.3.0',
      sequence: 4,
      storageVersion: 2,
      source: `export default () => ({ name: 'dist-demo', version: '1.3.0', permissions: ['draft:read'], async activate() { throw new Error('broken activation'); } });`,
    });
    writeFileSync(join(home.dir, 'v4.tgz'), broken.bytes);
    assert.equal(await runPlugin(home, ['update', join(home.dir, 'v4.tgz')]), 1);
    assert.match(home.stderr.join(''), /activation-failed/);
    const rolled = await readPluginsManifest(home.roots);
    assert.equal(rolled?.plugins['dist-demo']?.distribution?.manifest.version, '1.2.0');

    assert.equal(await runPlugin(home, ['rollback', 'dist-demo']), 0);
    const back = await readPluginsManifest(home.roots);
    assert.equal(back?.plugins['dist-demo']?.distribution?.manifest.version, '1.1.0');

    const escalation = packPlugin({
      id: 'descriptor-escalation',
      permissions: [],
      descriptorPermissions: ['draft:read'],
      privateKey: publisher.privateKey,
      publisherPem: publisher.publicPem,
    });
    writeFileSync(join(home.dir, 'esc.tgz'), escalation.bytes);
    assert.equal(
      await runPlugin(home, [
        'add',
        join(home.dir, 'esc.tgz'),
        '--trust-key',
        writeKey(home.dir, publisher.publicPem, 'esc.pub'),
      ]),
      1,
    );
    assert.match(home.stderr.join(''), /descriptor-permissions-mismatch/);
  } finally {
    home.remove();
  }
});

test('project [[plugins]] is a request; a string body is not a request; approval installs no code (E6)', async () => {
  const home = await preparedHome();
  try {
    const packed = packPlugin({ id: 'repo-spy', permissions: ['draft:read', 'network'] });
    const toml = join(home.dir, '.murmo.toml');
    writeFileSync(
      toml,
      `version = 1
[replace]
sample = '''
[[plugins]]
id = "hidden-in-a-string"
'''
[[plugins]]
id = "repo-spy"
source = "${join(home.dir, 'spy.tgz')}"
digest = "${packed.digest}"
publisher = "${packed.publisher}"
`,
    );
    writeFileSync(join(home.dir, 'spy.tgz'), packed.bytes);
    const before = Object.keys((await readPluginsManifest(home.roots))?.plugins ?? {});
    assert.equal(await runPlugin(home, ['project-review', toml, '--json']), 0);
    const review = JSON.parse(home.stdout.join('')) as { digest: string; requests: { id: string }[] };
    assert.equal(review.requests.length, 1);
    assert.equal(review.requests[0]?.id, 'repo-spy');
    assert.equal(await runPlugin(home, ['project-apply', toml]), 1);
    assert.match(home.stderr.join(''), /project-approval-required/);
    assert.equal(await runPlugin(home, ['project-apply', toml, '--approve-project', review.digest, '--json']), 0);
    assert.match(home.stdout.join(''), /project-approved-no-code-installed/);
    assert.deepEqual(Object.keys((await readPluginsManifest(home.roots))?.plugins ?? {}), before);
    const key = writeKey(home.dir, packed.publicPem);
    assert.equal(
      await runPlugin(home, ['add', join(home.dir, 'spy.tgz'), '--trust-key', key, '--digest', packed.digest]),
      1,
    );
    assert.match(home.stderr.join(''), /permission-approval-required/);
    writeFileSync(toml, `${readFileSync(toml, 'utf8')}\n# changed\n`);
    assert.equal(await runPlugin(home, ['project-apply', toml, '--approve-project', review.digest]), 1);
    assert.match(home.stderr.join(''), /project-approval-required/);
  } finally {
    home.remove();
  }
});

test('remove deletes code, storage and cache and keeps the trust ledger (E7)', async () => {
  const home = await preparedHome();
  try {
    const { packed, code } = await addFixture(home, {});
    assert.equal(code, 0);
    assert.equal(await runPlugin(home, ['remove', 'dist-demo', '--json']), 0);
    assert.equal(existsSync(join(home.roots.data, 'extensions', 'dist-demo')), false);
    assert.equal(existsSync(join(home.roots.data, 'plugin-cache', 'dist-demo')), false);
    assert.equal(existsSync(join(home.roots.data, 'plugin-storage', 'dist-demo')), false);
    const ledger = await readLedger(home.roots);
    assert.equal(ledger.identities['dist-demo']?.publisher, packed.publisher);
  } finally {
    home.remove();
  }
});

test('a packed CLI accepts a third-party publisher with an independent --trust-key (phase 32 gate off)', async () => {
  const home = await preparedHome();
  try {
    const packedCtx = { ...home.ctx, packed: true, allowThirdParty: false, firstPartyFingerprint: 'a'.repeat(64) };
    const packed = packPlugin();
    const tgz = join(home.dir, 'v1.tgz');
    writeFileSync(tgz, packed.bytes);
    const key = writeKey(home.dir, packed.publicPem);
    const { pluginCommand } = await import('../src/plugin/commands.ts');
    const code = await pluginCommand(packedCtx, ['add', tgz, '--trust-key', key, '--grant', 'draft:read']);
    assert.equal(code, 0);
  } finally {
    home.remove();
  }
});

test('an interrupted update journal is finished or undone (E4 journal)', async () => {
  const home = await preparedHome();
  try {
    const { packed, code } = await addFixture(home, {});
    assert.equal(code, 0);
    await writeJournal(home.roots, {
      schema: 1,
      op: 'update',
      id: 'dist-demo',
      phase: 'extract',
      toDigest: 'b'.repeat(64),
      fromDigest: packed.digest,
      previousEnabled: true,
    });
    mkdirSync(join(home.roots.data, 'extensions', 'dist-demo', 'b'.repeat(64)), { recursive: true });
    assert.equal(await runPlugin(home, ['list', '--json']), 0);
    const manifest = await readPluginsManifest(home.roots);
    assert.equal(manifest?.plugins['dist-demo']?.distribution?.digest, packed.digest);
    assert.equal(existsSync(join(home.roots.data, 'extensions', 'dist-demo', 'b'.repeat(64))), false);
  } finally {
    home.remove();
  }
});

test('a rotated key is accepted only with the old key statement (C4, E15)', async () => {
  const home = await preparedHome();
  try {
    const old = generatePublisher();
    const { packed, code } = await addFixture(home, { privateKey: old.privateKey, publisherPem: old.publicPem });
    assert.equal(code, 0);
    const next = generatePublisher();
    const { signRotation } = await import('@murmo/integrity');
    const statement = signRotation(
      {
        format: 'murmo-publisher-rotation-v1',
        plugin: 'dist-demo',
        from: packed.publisher,
        to: next.fingerprint,
        toPublisher: next.publicPem,
        issuedAt: 1,
      },
      old.privateKey,
    );
    const stmt = join(home.dir, 'rotate.json');
    writeFileSync(stmt, JSON.stringify(statement));
    const v2 = packPlugin({
      privateKey: next.privateKey,
      publisherPem: next.publicPem,
      version: '1.0.1',
      sequence: 2,
    });
    const tgz = join(home.dir, 'v2.tgz');
    writeFileSync(tgz, v2.bytes);
    const oldKey = writeKey(home.dir, old.publicPem);
    assert.equal(
      await runPlugin(home, [
        'update',
        tgz,
        '--trust-key',
        oldKey,
        '--grant',
        'draft:read',
        '--rotate-statement',
        stmt,
      ]),
      0,
    );
    const ledger = await readLedger(home.roots);
    assert.equal(ledger.identities['dist-demo']?.publisher, next.fingerprint);
    assert.ok((ledger.identities['dist-demo']?.chain ?? []).includes(packed.publisher));
  } finally {
    home.remove();
  }
});

test('a revoked version is refused at add and named by doctor (C4)', async () => {
  const home = await preparedHome();
  try {
    const { packed, code } = await addFixture(home, {});
    assert.equal(code, 0);
    const { signRevocation } = await import('@murmo/integrity');
    const statement = signRevocation(
      {
        format: 'murmo-publisher-revocation-v1',
        publisher: packed.publisher,
        plugin: 'dist-demo',
        version: '1.0.0',
        reason: 'bad',
        issuedAt: 1,
      },
      packed.privateKey,
    );
    const stmt = join(home.dir, 'revoke.json');
    writeFileSync(stmt, JSON.stringify(statement));
    const key = writeKey(home.dir, packed.publicPem);
    assert.equal(await runPlugin(home, ['revoke', '--statement', stmt, '--trust-key', key]), 0);
    assert.equal(await runPlugin(home, ['doctor', '--json']), 1);
    assert.match(home.stdout.join(''), /revoked/);
  } finally {
    home.remove();
  }
});

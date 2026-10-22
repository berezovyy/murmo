// Signed index integrity, local search, add-by-id pins, and revocation ingest
// (plan 33 tests and acceptance). Loopback fixture only: no public registry.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { ENVELOPE_FILE, sha256Bytes } from '@murmo/integrity';
import { readLedger, readPluginsManifest } from '@murmo/store/node';
import {
  envelopeSha256,
  formatArchiveDigest,
  INDEX_FORMAT,
  type IndexPlugin,
  inspectArchive,
  parseRegistryTarget,
  type SignedRegistryIndex,
  signIndex,
} from '../src/plugin/index.ts';
import { sha512Integrity } from '../src/plugin/sources.ts';
import { generatePublisher, packPlugin, preparedHome, runPlugin, writeKey } from './helpers.ts';

const INDEX = 'http://127.0.0.1:9/index.json';

function listedAt(): string {
  return '2026-10-22';
}

function pluginEntry(
  packed: ReturnType<typeof packPlugin>,
  extra: { archives?: Record<string, string>; source?: string; revoked?: IndexPlugin['revoked'] } = {},
): IndexPlugin {
  const inspected = inspectArchive(packed.bytes);
  return {
    id: inspected.envelope.id,
    publisher: {
      name: 'fixture-publisher',
      spki_sha256: packed.publisher,
      keys: [packed.publicPem],
    },
    versions: [
      {
        version: inspected.envelope.version,
        api: inspected.envelope.api,
        source: extra.source ?? `npm:${inspected.envelope.id}@${inspected.envelope.version}`,
        envelope_sha256: envelopeSha256(inspected),
        archives: extra.archives ?? { npm: formatArchiveDigest(inspected.digest) },
        permissions: inspected.envelope.permissions.map((name) => ({
          name,
          reason: inspected.envelope.reasons[name] as string,
        })),
        capabilities: { required: ['pi', 'opencode'], optional: [] },
        license: 'MIT',
        listed_at: listedAt(),
      },
    ],
    ...(extra.revoked ? { revoked: extra.revoked } : {}),
  };
}

function makeIndex(
  registry: ReturnType<typeof generatePublisher>,
  plugins: IndexPlugin[],
  fields: { version?: number; issuedAt?: number; expiresAt?: number } = {},
): { signed: SignedRegistryIndex; bytes: Buffer; key: ReturnType<typeof generatePublisher> } {
  const now = Date.now();
  const signed = signIndex(
    {
      format: INDEX_FORMAT,
      version: fields.version ?? 1,
      issuedAt: fields.issuedAt ?? now,
      expiresAt: fields.expiresAt ?? now + 86_400_000,
      plugins,
    },
    registry.privateKey,
  );
  return { signed, bytes: Buffer.from(JSON.stringify(signed)), key: registry };
}

async function withIndex(
  home: Awaited<ReturnType<typeof preparedHome>>,
  indexBytes: Buffer,
  extra: (url: URL) => Promise<Uint8Array | undefined> = async () => undefined,
): Promise<string[]> {
  const requests: string[] = [];
  home.setGet(async (url) => {
    requests.push(url.href);
    if (url.href === INDEX || url.pathname.endsWith('/index.json')) return indexBytes;
    const hit = await extra(url);
    if (hit) return hit;
    throw new Error(`unexpected fetch ${url.href}`);
  });
  return requests;
}

function indexArgs(registryKey: string, extra: string[] = []): string[] {
  return ['--index', INDEX, '--registry-key', registryKey, ...extra];
}

test('parseRegistryTarget accepts bare ids and refuses source specs', () => {
  const cwd = process.cwd();
  assert.deepEqual(parseRegistryTarget('files-picker', cwd), { id: 'files-picker' });
  assert.deepEqual(parseRegistryTarget('files-picker@1.2.0', cwd), { id: 'files-picker', version: '1.2.0' });
  assert.equal(parseRegistryTarget('npm:files-picker@1.2.0', cwd), undefined);
  assert.equal(parseRegistryTarget('git+file:///tmp/x.git#abc', cwd), undefined);
  assert.equal(parseRegistryTarget('http://127.0.0.1/x.tgz', cwd), undefined);
});

test('a tampered index, a wrong-key index, an older index and an expired index are refused or warned (plan 33)', async () => {
  const home = await preparedHome();
  try {
    const registry = generatePublisher();
    const packed = packPlugin({ id: 'files-picker' });
    const { signed, bytes } = makeIndex(registry, [pluginEntry(packed)]);
    const key = writeKey(home.dir, registry.publicPem, 'registry.pub');

    const first = signed.plugins[0];
    if (!first) throw new Error('expected a plugin');
    const tampered = Buffer.from(JSON.stringify({ ...signed, plugins: [{ ...first, id: 'evil' }] }));
    await withIndex(home, tampered);
    assert.equal(await runPlugin(home, ['search', 'files', ...indexArgs(key)]), 1);
    assert.match(home.stderr.join(''), /registry-index-tampered|signature-mismatch/);

    const other = generatePublisher();
    const wrongKey = writeKey(home.dir, other.publicPem, 'other.pub');
    await withIndex(home, bytes);
    assert.equal(await runPlugin(home, ['search', 'files', ...indexArgs(wrongKey)]), 1);
    assert.match(home.stderr.join(''), /registry-index-tampered|registry-key-mismatch/);

    await withIndex(home, makeIndex(registry, [pluginEntry(packed)], { version: 2 }).bytes);
    assert.equal(await runPlugin(home, ['search', 'files', ...indexArgs(key)]), 0);
    await withIndex(home, makeIndex(registry, [pluginEntry(packed)], { version: 1 }).bytes);
    assert.equal(await runPlugin(home, ['search', 'files', '--refresh', ...indexArgs(key)]), 1);
    assert.match(home.stderr.join(''), /registry-index-rollback/);

    const expiredHome = await preparedHome();
    try {
      await withIndex(expiredHome, makeIndex(registry, [pluginEntry(packed)], { issuedAt: 1, expiresAt: 2 }).bytes);
      assert.equal(await runPlugin(expiredHome, ['search', 'files', ...indexArgs(key)]), 0);
      assert.match(expiredHome.stderr.join(''), /registry-index-expired/);
      assert.match(expiredHome.stdout.join(''), /files-picker/);
    } finally {
      expiredHome.remove();
    }
  } finally {
    home.remove();
  }
});

test('search GETs only the index URL and never the query (E16)', async () => {
  const home = await preparedHome();
  try {
    const registry = generatePublisher();
    const packed = packPlugin({ id: 'files-picker' });
    const { bytes } = makeIndex(registry, [pluginEntry(packed)]);
    const key = writeKey(home.dir, registry.publicPem, 'registry.pub');
    const requests = await withIndex(home, bytes);
    assert.equal(await runPlugin(home, ['search', 'secret-prompt-text', '--json', ...indexArgs(key)]), 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0], INDEX);
    assert.equal(requests[0]?.includes('secret-prompt-text'), false);
    const hits = await withIndex(home, bytes);
    assert.equal(await runPlugin(home, ['search', 'files-picker', '--json', ...indexArgs(key)]), 0);
    assert.equal(hits.length, 0);
    assert.match(home.stdout.join(''), /files-picker/);
  } finally {
    home.remove();
  }
});

test('add by id checks the listed archive digest; local pins catch a substituted tarball (D1, D2)', async () => {
  const home = await preparedHome();
  try {
    const registry = generatePublisher();
    const packed = packPlugin({ id: 'files-picker' });
    const key = writeKey(home.dir, packed.publicPem);
    const registryKey = writeKey(home.dir, registry.publicPem, 'registry.pub');
    const wrong = makeIndex(registry, [
      pluginEntry(packed, { archives: { npm: formatArchiveDigest('ab'.repeat(32)) } }),
    ]);
    await withIndex(home, wrong.bytes, async (url) => {
      if (url.pathname.endsWith('/artifact.tgz')) return packed.bytes;
      if (url.pathname.includes('/files-picker/')) {
        return Buffer.from(
          JSON.stringify({
            dist: { tarball: 'http://127.0.0.1:9/artifact.tgz', integrity: sha512Integrity(packed.bytes) },
          }),
        );
      }
      return undefined;
    });
    assert.equal(
      await runPlugin(home, [
        'add',
        'files-picker',
        '--trust-key',
        key,
        '--grant',
        'draft:read',
        '--registry',
        'http://127.0.0.1:9',
        ...indexArgs(registryKey),
      ]),
      1,
    );
    assert.match(home.stderr.join(''), /archive-digest-mismatch/);

    const { bytes } = makeIndex(registry, [pluginEntry(packed)]);
    await withIndex(home, bytes, async (url) => {
      if (url.pathname.endsWith('/artifact.tgz')) return packed.bytes;
      if (url.pathname.includes('/files-picker/')) {
        return Buffer.from(
          JSON.stringify({
            dist: { tarball: 'http://127.0.0.1:9/artifact.tgz', integrity: sha512Integrity(packed.bytes) },
          }),
        );
      }
      return undefined;
    });
    assert.equal(
      await runPlugin(home, [
        'add',
        'files-picker',
        '--trust-key',
        key,
        '--grant',
        'draft:read',
        '--registry',
        'http://127.0.0.1:9',
        '--refresh',
        ...indexArgs(registryKey),
      ]),
      0,
    );

    const swapped = packPlugin({
      id: 'files-picker',
      extraFiles: { 'note.txt': 'other' },
      privateKey: packed.privateKey,
      publisherPem: packed.publicPem,
    });
    await withIndex(home, bytes, async (url) => {
      if (url.pathname.endsWith('/artifact.tgz')) return swapped.bytes;
      if (url.pathname.includes('/files-picker/')) {
        return Buffer.from(
          JSON.stringify({
            dist: { tarball: 'http://127.0.0.1:9/artifact.tgz', integrity: sha512Integrity(swapped.bytes) },
          }),
        );
      }
      return undefined;
    });
    assert.equal(
      await runPlugin(home, [
        'update',
        'npm:files-picker@1.0.0',
        '--registry',
        'http://127.0.0.1:9',
        ...indexArgs(registryKey),
      ]),
      1,
    );
    assert.match(home.stderr.join(''), /version-content-changed|archive-digest-mismatch/);
  } finally {
    home.remove();
  }
});

test('npm gzip and git tar of the same release share envelope_sha256 and differ in archive bytes (D1)', async () => {
  const home = await preparedHome();
  try {
    const packed = packPlugin({ id: 'files-picker' });
    const tar = gunzipSync(packed.bytes);
    const npmInspected = inspectArchive(packed.bytes);
    const gitInspected = inspectArchive(tar);
    assert.equal(envelopeSha256(npmInspected), envelopeSha256(gitInspected));
    assert.notEqual(npmInspected.digest, gitInspected.digest);
    assert.equal(sha256Bytes(npmInspected.files[ENVELOPE_FILE] as Uint8Array), envelopeSha256(npmInspected));

    const gitDir = join(home.dir, 'source.git');
    const work = join(home.dir, 'git-work');
    mkdirSync(work);
    const { unpackArchive } = await import('../src/plugin/archive.ts');
    for (const [name, bytes] of Object.entries(unpackArchive(packed.bytes))) {
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
    const other = await preparedHome();
    try {
      const pub = writeKey(other.dir, packed.publicPem);
      assert.equal(
        await runPlugin(other, ['add', `git+file://${gitDir}#${commit}`, '--trust-key', pub, '--grant', 'draft:read']),
        0,
      );
      const installed = await readPluginsManifest(other.roots);
      const gitDigest = installed?.plugins['files-picker']?.distribution?.digest;
      assert.ok(gitDigest);
      assert.notEqual(gitDigest, npmInspected.digest);
      const { pluginCacheFile } = await import('@murmo/store');
      const { readFileSync } = await import('node:fs');
      const cached = inspectArchive(readFileSync(pluginCacheFile(other.roots, 'files-picker', gitDigest as string)));
      assert.equal(envelopeSha256(cached), envelopeSha256(npmInspected));
    } finally {
      other.remove();
    }
  } finally {
    home.remove();
  }
});

test('a revocation published only in the index reaches the ledger check on the next plugin command', async () => {
  const home = await preparedHome();
  try {
    const registry = generatePublisher();
    const packed = packPlugin({ id: 'files-picker' });
    const key = writeKey(home.dir, packed.publicPem);
    const registryKey = writeKey(home.dir, registry.publicPem, 'registry.pub');
    const tgz = join(home.dir, 'v1.tgz');
    writeFileSync(tgz, packed.bytes);
    assert.equal(await runPlugin(home, ['add', tgz, '--trust-key', key, '--grant', 'draft:read']), 0);

    const { bytes } = makeIndex(registry, [
      pluginEntry(packed, {
        revoked: [{ version: '1.0.0', reason: 'malicious', at: '2026-10-22' }],
      }),
    ]);
    await withIndex(home, bytes);
    assert.equal(await runPlugin(home, ['search', 'files-picker', ...indexArgs(registryKey)]), 0);
    const ledger = await readLedger(home.roots);
    assert.equal(
      ledger.revocations?.some((row) => row.plugin === 'files-picker' && row.version === '1.0.0'),
      true,
    );
    assert.equal(await runPlugin(home, ['doctor', '--json', ...indexArgs(registryKey)]), 1);
    assert.match(home.stdout.join('') + home.stderr.join(''), /revoked/);
    const manifest = await readPluginsManifest(home.roots);
    assert.equal(manifest?.plugins['files-picker']?.enabled, false);
  } finally {
    home.remove();
  }
});

test('unlisted add fails; git and tarball still install with no index (plan 33)', async () => {
  const home = await preparedHome();
  try {
    const registry = generatePublisher();
    const packed = packPlugin({ id: 'files-picker' });
    const registryKey = writeKey(home.dir, registry.publicPem, 'registry.pub');
    const { bytes } = makeIndex(registry, [pluginEntry(packed)]);
    await withIndex(home, bytes);
    assert.equal(await runPlugin(home, ['add', 'missing-plugin', ...indexArgs(registryKey)]), 1);
    assert.match(home.stderr.join(''), /unlisted-plugin/);

    const isolated = await preparedHome();
    try {
      isolated.setGet(async (url) => {
        throw new Error(`index must not be contacted ${url.href}`);
      });
      const tgz = join(isolated.dir, 'v1.tgz');
      writeFileSync(tgz, packed.bytes);
      const key = writeKey(isolated.dir, packed.publicPem);
      assert.equal(await runPlugin(isolated, ['add', tgz, '--trust-key', key, '--grant', 'draft:read']), 0);
      const digest = (await readPluginsManifest(isolated.roots))?.plugins['files-picker']?.distribution?.digest;
      assert.ok(digest);
      const { rmSync } = await import('node:fs');
      rmSync(join(isolated.roots.data, 'extensions', 'files-picker', digest as string), {
        recursive: true,
        force: true,
      });
      isolated.setGet(async () => {
        throw new Error('offline reinstall must not fetch');
      });
      assert.equal(await runPlugin(isolated, ['reinstall', 'files-picker', '--offline']), 0);
    } finally {
      isolated.remove();
    }
  } finally {
    home.remove();
  }
});

test('a listing never grants permissions and never replaces the publisher key', async () => {
  const home = await preparedHome();
  try {
    const registry = generatePublisher();
    const packed = packPlugin({ id: 'files-picker' });
    const registryKey = writeKey(home.dir, registry.publicPem, 'registry.pub');
    const { bytes } = makeIndex(registry, [pluginEntry(packed)]);
    await withIndex(home, bytes, async (url) => {
      if (url.pathname.endsWith('/artifact.tgz')) return packed.bytes;
      if (url.pathname.includes('/files-picker/')) {
        return Buffer.from(
          JSON.stringify({
            dist: { tarball: 'http://127.0.0.1:9/artifact.tgz', integrity: sha512Integrity(packed.bytes) },
          }),
        );
      }
      return undefined;
    });
    assert.equal(
      await runPlugin(home, ['add', 'files-picker', '--registry', 'http://127.0.0.1:9', ...indexArgs(registryKey)]),
      1,
    );
    assert.match(home.stderr.join(''), /publisher-approval-required/);
    const key = writeKey(home.dir, packed.publicPem);
    assert.equal(
      await runPlugin(home, [
        'add',
        'files-picker',
        '--trust-key',
        key,
        '--registry',
        'http://127.0.0.1:9',
        ...indexArgs(registryKey),
      ]),
      1,
    );
    assert.match(home.stderr.join(''), /permission-approval-required/);
    assert.equal(await runPlugin(home, ['info', 'files-picker', '--json', ...indexArgs(registryKey)]), 0);
    assert.match(home.stdout.join(''), /listing is not a grant|files-picker/);
  } finally {
    home.remove();
  }
});

// Installed-artifact checks that do not need a real host (E1, E8, E10).
// One-correction-per-host needs phase 27 setup and the phase 20 harness.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  buildManifest,
  helperPath,
  keyIdOf,
  MODE_EXEC,
  publicFromPrivate,
  verifyPackage,
  writeSigned,
} from '@murmo/integrity';
import { generatedPackageJson } from '../src/adapters.ts';
import { npmPack } from '../src/archive.ts';
import { glibcTooNew, glibcVersions } from '../src/binaries.ts';

const root = mkdtempSync(join(tmpdir(), 'murmo-smoke-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('npm pack --ignore-scripts keeps 0755 on binaries and loads tui.js by path and ./tui by name', async () => {
  const pkg = join(root, 'package');
  mkdirSync(join(pkg, 'adapters/opencode'), { recursive: true });
  mkdirSync(join(pkg, 'adapters/pi'), { recursive: true });
  mkdirSync(join(pkg, 'bin/darwin-arm64'), { recursive: true });
  mkdirSync(join(pkg, '.claude-plugin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), `${JSON.stringify(generatedPackageJson(), null, 2)}\n`);
  writeFileSync(join(pkg, 'cli.mjs'), '#!/usr/bin/env node\nexport const ok = 1;\n');
  writeFileSync(join(pkg, 'tui.js'), 'export default { id: "murmo" };\n');
  writeFileSync(join(pkg, 'adapters/opencode/tui.js'), 'export default { id: "murmo" };\n');
  writeFileSync(join(pkg, 'adapters/pi/index.js'), 'export default function murmo() {}\n');
  writeFileSync(join(pkg, helperPath('darwin-arm64')), '#!/bin/sh\necho helper\n');
  writeFileSync(join(pkg, 'bin/darwin-arm64/murmo-codex'), '#!/bin/sh\necho murmo-codex\n');
  writeFileSync(join(pkg, 'compat.json'), '{}\n');
  writeFileSync(
    join(pkg, '.claude-plugin/marketplace.json'),
    '{"name":"murmo-local","plugins":[{"name":"murmo","source":"./adapters/claude"}]}\n',
  );
  chmodSync(join(pkg, 'cli.mjs'), MODE_EXEC);
  chmodSync(join(pkg, helperPath('darwin-arm64')), MODE_EXEC);
  chmodSync(join(pkg, 'bin/darwin-arm64/murmo-codex'), MODE_EXEC);

  const key = generateKeyPairSync('ed25519');
  writeSigned(
    pkg,
    buildManifest(pkg, {
      version: '0.0.0',
      commit: 'test',
      keyId: keyIdOf(publicFromPrivate(key.privateKey)),
      compatSha256: '00',
    }),
    key.privateKey,
  );

  const tgz = npmPack(pkg, root);
  const prefix = join(root, 'prefix');
  const cache = join(root, 'npm-cache');
  mkdirSync(prefix);
  mkdirSync(cache);
  execFileSync('npm', ['install', '--ignore-scripts', '--offline', '--prefix', prefix, '--cache', cache, tgz], {
    stdio: 'pipe',
  });
  const installed = join(prefix, 'node_modules', 'murmo');
  assert.equal(statSync(join(installed, 'bin/darwin-arm64/murmo-codex')).mode & 0o777, MODE_EXEC);
  assert.equal(statSync(join(installed, helperPath('darwin-arm64'))).mode & 0o777, MODE_EXEC);
  assert.equal(statSync(join(installed, 'cli.mjs')).mode & 0o111, 0o111);

  const pkgJson = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
    exports: { './tui': string };
    pi: { extensions: string[] };
    scripts?: unknown;
  };
  assert.equal(pkgJson.exports['./tui'], './tui.js');
  assert.deepEqual(pkgJson.pi.extensions, ['./adapters/pi/index.js']);
  assert.equal(pkgJson.scripts, undefined);

  const tui = await import(pathToFileURL(join(installed, 'tui.js')).href);
  assert.equal((tui as { default: { id: string } }).default.id, 'murmo');
  const named = await import(pathToFileURL(join(installed, pkgJson.exports['./tui'])).href);
  assert.equal((named as { default: { id: string } }).default.id, 'murmo');
  const pi = await import(pathToFileURL(join(installed, pkgJson.pi.extensions[0] as string)).href);
  assert.equal(typeof (pi as { default: unknown }).default, 'function');

  const marketplace = JSON.parse(readFileSync(join(installed, '.claude-plugin/marketplace.json'), 'utf8')) as {
    plugins: { source: string }[];
  };
  assert.equal(marketplace.plugins[0]?.source, './adapters/claude');

  verifyPackage(installed, { publicKey: key.publicKey });
});

test('linux binaries that need GLIBC_2.39 are refused (E12)', () => {
  const fake = Buffer.from('GLIBC_2.36\0GLIBC_2.39\0GLIBC_2.17');
  const versions = glibcVersions(fake);
  assert.deepEqual(glibcTooNew(versions), ['2.39']);
  assert.deepEqual(glibcTooNew(['2.28', '2.36']), []);
});

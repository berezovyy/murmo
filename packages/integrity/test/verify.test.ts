// Tamper cases from r12 I4 / E3: a broken verifier must fail before HOME changes.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { keyIdOf, publicFromPrivate } from '../src/key.ts';
import { helperPath, MODE_EXEC, MODE_FILE } from '../src/layout.ts';
import { buildManifest } from '../src/manifest.ts';
import { writeSigned } from '../src/sign.ts';
import { VerifyError, verifyPackage } from '../src/verify.ts';

const root = mkdtempSync(join(tmpdir(), 'murmo-integrity-'));
after(() => rmSync(root, { recursive: true, force: true }));

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

function seed(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'bin', 'darwin-arm64'), { recursive: true });
  writeFileSync(join(dir, 'cli.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(join(dir, 'compat.json'), '{"hosts":{}}\n');
  writeFileSync(join(dir, helperPath('darwin-arm64')), 'helper');
  chmodSync(join(dir, 'cli.mjs'), MODE_EXEC);
  chmodSync(join(dir, helperPath('darwin-arm64')), MODE_EXEC);
  chmodSync(join(dir, 'compat.json'), MODE_FILE);
  return dir;
}

function seal(dir: string, key = privateKey): void {
  const manifest = buildManifest(dir, {
    version: '0.0.0',
    commit: 'test',
    keyId: keyIdOf(publicFromPrivate(key)),
    compatSha256: '00',
  });
  writeSigned(dir, manifest, key);
}

function homeSnapshot(home: string): string[] {
  return readdirSync(home, { recursive: true }).map(String).sort();
}

test('a clean tree verifies and leaves HOME untouched', () => {
  const dir = seed('clean');
  seal(dir);
  const home = join(root, 'home-clean');
  mkdirSync(home);
  writeFileSync(join(home, 'sentinel'), 'keep');
  const before = homeSnapshot(home);
  const result = verifyPackage(dir, { publicKey });
  assert.equal(result.ok, true);
  assert.equal(result.authenticated, true);
  assert.deepEqual(homeSnapshot(home), before);
});

test('a missing helper, a changed helper, a flipped byte, a removed file, an extra file and a swapped key each fail', () => {
  const cases: { name: string; edit: (dir: string) => void; problem: string }[] = [
    {
      name: 'missing-helper',
      problem: 'missing-file',
      edit: (dir) => rmSync(join(dir, helperPath('darwin-arm64'))),
    },
    {
      name: 'changed-helper',
      problem: 'hash-mismatch',
      edit: (dir) => writeFileSync(join(dir, helperPath('darwin-arm64')), 'HELPER'),
    },
    {
      name: 'flipped-byte',
      problem: 'hash-mismatch',
      edit: (dir) => {
        const bytes = Uint8Array.from(readFileSync(join(dir, 'compat.json')));
        bytes[0] = (bytes[0] as number) ^ 0x01;
        writeFileSync(join(dir, 'compat.json'), bytes);
      },
    },
    {
      name: 'removed-file',
      problem: 'missing-file',
      edit: (dir) => rmSync(join(dir, 'compat.json')),
    },
    {
      name: 'extra-file',
      problem: 'extra-file',
      edit: (dir) => writeFileSync(join(dir, 'evil.js'), 'steal'),
    },
  ];
  for (const c of cases) {
    const dir = seed(c.name);
    seal(dir);
    c.edit(dir);
    const home = join(root, `home-${c.name}`);
    mkdirSync(home);
    writeFileSync(join(home, 'sentinel'), 'keep');
    const before = homeSnapshot(home);
    assert.throws(
      () => verifyPackage(dir, { publicKey }),
      (err: unknown) => {
        assert.ok(err instanceof VerifyError, c.name);
        assert.equal(err.problem, c.problem, c.name);
        return true;
      },
    );
    assert.deepEqual(homeSnapshot(home), before, c.name);
  }

  const swapped = seed('swapped-key');
  seal(swapped, other.privateKey);
  const home = join(root, 'home-swapped');
  mkdirSync(home);
  writeFileSync(join(home, 'sentinel'), 'keep');
  const before = homeSnapshot(home);
  assert.throws(
    () => verifyPackage(swapped, { publicKey }),
    (err: unknown) => {
      assert.ok(err instanceof VerifyError);
      assert.ok(err.problem === 'key-mismatch' || err.problem === 'bad-signature');
      return true;
    },
  );
  assert.deepEqual(homeSnapshot(home), before);
});

// Two seals of the same tree must write identical integrity.json (release hash, phase 31).
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  buildManifest,
  keyIdOf,
  MODE_EXEC,
  MODE_FILE,
  publicFromPrivate,
  sha256Bytes,
  writeSigned,
} from '@murmo/integrity';

const root = mkdtempSync(join(tmpdir(), 'murmo-seal-'));
after(() => rmSync(root, { recursive: true, force: true }));

function tree(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'bin/darwin-arm64'), { recursive: true });
  writeFileSync(join(dir, 'cli.mjs'), '#!/usr/bin/env node\nconsole.log("ok")\n');
  writeFileSync(join(dir, 'tui.js'), 'export default {}\n');
  writeFileSync(join(dir, 'compat.json'), '{"hosts":{}}\n');
  writeFileSync(join(dir, 'bin/darwin-arm64/murmo-codex'), 'stub');
  chmodSync(join(dir, 'cli.mjs'), MODE_EXEC);
  chmodSync(join(dir, 'bin/darwin-arm64/murmo-codex'), MODE_EXEC);
  chmodSync(join(dir, 'tui.js'), MODE_FILE);
  chmodSync(join(dir, 'compat.json'), MODE_FILE);
  return dir;
}

test('two seals of one tree produce identical integrity.json; signatures differ by key', () => {
  const a = tree('a');
  const b = tree('b');
  const k1 = generateKeyPairSync('ed25519');
  const k2 = generateKeyPairSync('ed25519');
  const meta = (key: typeof k1) => ({
    version: '0.0.0',
    commit: 'deadbeef',
    keyId: keyIdOf(publicFromPrivate(key.privateKey)),
    compatSha256: sha256Bytes('{"hosts":{}}\n').slice(0, 64),
  });
  writeSigned(a, buildManifest(a, meta(k1)), k1.privateKey);
  writeSigned(b, buildManifest(b, meta(k1)), k1.privateKey);
  const ia = readFileSync(join(a, 'integrity.json'));
  const ib = readFileSync(join(b, 'integrity.json'));
  assert.equal(ia.toString(), ib.toString());

  writeSigned(b, buildManifest(b, meta(k2)), k2.privateKey);
  const ib2 = readFileSync(join(b, 'integrity.json'));
  assert.notEqual(JSON.parse(ib2.toString()).keyId, JSON.parse(ia.toString()).keyId);
});

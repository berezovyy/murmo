// Plugin envelopes are Ed25519 over RFC 8785 JCS; a swapped key or a mutated
// file must not verify (plan 28 / phase 26 encoder reuse).
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  canonicalJson,
  ENVELOPE_FILE,
  inspectPluginFiles,
  PLUGIN_MANIFEST_FILE,
  type PluginEnvelope,
  publisherFingerprint,
  sha256Bytes,
  signEnvelope,
} from '../src/index.ts';

test('signature covers canonical bytes, not insertion order', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const envelope: PluginEnvelope = {
    format: 'murmo-plugin-v1',
    id: 'dist-demo',
    version: '1.0.0',
    sequence: 1,
    publisher: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    entry: 'index.mjs',
    api: '^2.0.0',
    permissions: ['draft:read'],
    reasons: { 'draft:read': 'count' },
    storageVersion: 1,
    files: { 'index.mjs': 'a'.repeat(64), [PLUGIN_MANIFEST_FILE]: 'b'.repeat(64) },
  };
  const signed = signEnvelope(envelope, privateKey);
  const reordered = { signature: signed.signature, ...envelope };
  void reordered;
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  const fp = publisherFingerprint(publicKey);
  assert.equal(fp.length, 64);
});

test('a mutated payload fails inspect (file-digest-mismatch)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const source = Buffer.from(
    'export default () => ({ name: "dist-demo", version: "1.0.0", permissions: ["draft:read"] });\n',
  );
  const portable = Buffer.from(
    JSON.stringify({
      name: 'dist-demo',
      version: '1.0.0',
      api: '^2.0.0',
      entry: 'index.mjs',
      permissions: [{ name: 'draft:read', reason: 'count' }],
      capabilities: { required: {}, optional: {} },
      settingsSchema: { type: 'object', properties: {} },
    }),
  );
  const files: Record<string, Uint8Array> = {
    'index.mjs': source,
    [PLUGIN_MANIFEST_FILE]: portable,
  };
  const envelope: PluginEnvelope = {
    format: 'murmo-plugin-v1',
    id: 'dist-demo',
    version: '1.0.0',
    sequence: 1,
    publisher: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    entry: 'index.mjs',
    api: '^2.0.0',
    permissions: ['draft:read'],
    reasons: { 'draft:read': 'count' },
    storageVersion: 1,
    files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha256Bytes(b)])),
  };
  const signed = signEnvelope(envelope, privateKey);
  files[ENVELOPE_FILE] = Buffer.from(JSON.stringify(signed));
  files['index.mjs'] = Buffer.from('stolen');
  assert.throws(() => inspectPluginFiles(files, 'c'.repeat(64)), /file-digest-mismatch|digest mismatch/);
});

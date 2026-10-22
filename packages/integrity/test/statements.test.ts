// Rotation and revocation use canonical signed bytes, not JSON.stringify (E15).
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { publisherFingerprint, signRevocation, signRotation, verifyRevocation, verifyRotation } from '../src/index.ts';

function pair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { publicKey, privateKey, pem, fingerprint: publisherFingerprint(publicKey) };
}

test('a rotation without the old key is refused; with it the new key is accepted (C4)', () => {
  const old = pair();
  const next = pair();
  const signed = signRotation(
    {
      format: 'murmo-publisher-rotation-v1',
      plugin: 'demo',
      from: old.fingerprint,
      to: next.fingerprint,
      toPublisher: next.pem,
      issuedAt: 1,
    },
    old.privateKey,
  );
  assert.equal(verifyRotation(signed, old.publicKey), next.fingerprint);
  assert.throws(() => verifyRotation(signed, next.publicKey));
});

test('a revocation marks a key or version (C4)', () => {
  const pub = pair();
  const signed = signRevocation(
    {
      format: 'murmo-publisher-revocation-v1',
      publisher: pub.fingerprint,
      plugin: 'demo',
      version: '1.0.0',
      reason: 'compromised',
      issuedAt: 1,
    },
    pub.privateKey,
  );
  assert.equal(verifyRevocation(signed, pub.publicKey), pub.fingerprint);
});

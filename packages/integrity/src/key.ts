// Ed25519 keys live outside the repo. Pack never generates a key and never
// writes a public key into the CLI (docs/plan/26 E4, E5).

import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyError';
  }
}

/** SHA-256 of the raw 32-byte public key, lowercase hex. */
export function fingerprint(publicKey: KeyObject): string {
  return createHash('sha256').update(rawPublicKey(publicKey)).digest('hex');
}

/** First 16 hex chars of the fingerprint, recorded as `keyId` in integrity.json. */
export function keyIdOf(publicKey: KeyObject): string {
  return fingerprint(publicKey).slice(0, 16);
}

export function rawPublicKey(publicKey: KeyObject): Uint8Array {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  if (der.length < 32) throw new KeyError('Ed25519 SPKI is shorter than 32 bytes');
  return der.subarray(der.length - 32);
}

export function loadPrivateKey(pem: string | Uint8Array): KeyObject {
  const key = createPrivateKey(typeof pem === 'string' ? pem : Buffer.from(pem));
  if (key.asymmetricKeyType !== 'ed25519') throw new KeyError(`expected Ed25519, got ${key.asymmetricKeyType}`);
  return key;
}

export function loadPublicKey(pem: string | Uint8Array): KeyObject {
  const key = createPublicKey(typeof pem === 'string' ? pem : Buffer.from(pem));
  if (key.asymmetricKeyType !== 'ed25519') throw new KeyError(`expected Ed25519, got ${key.asymmetricKeyType}`);
  return key;
}

export function publicFromPrivate(privateKey: KeyObject): KeyObject {
  return createPublicKey(privateKey);
}

/**
 * Reads a PKCS#8 PEM from a path that must not sit under `experiments/`.
 * The leftover hosts-r14 test key is still on disk (E5) and must never sign.
 */
export function readSigningKey(path: string): KeyObject {
  const real = realpathSync(path);
  if (real.split(/[/\\]/).includes('experiments')) {
    throw new KeyError(`refusing a signing key under experiments/: ${path}`);
  }
  return loadPrivateKey(readFileSync(real));
}

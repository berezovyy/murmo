// Publisher rotation and revocation statements. Ed25519 over RFC 8785 JCS
// (phase 26 encoder). A key inside an archive never bootstraps trust (D2).

import { createPublicKey, sign as ed25519Sign, verify as ed25519Verify, type KeyObject } from 'node:crypto';
import { canonicalBytes } from './canonical.ts';
import { publisherFingerprint } from './envelope.ts';
import { KeyError, loadPrivateKey, loadPublicKey } from './key.ts';

export const ROTATION_FORMAT = 'murmo-publisher-rotation-v1';
export const REVOCATION_FORMAT = 'murmo-publisher-revocation-v1';

export class StatementError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StatementError';
    this.code = code;
  }
}

export interface RotationBody {
  readonly format: typeof ROTATION_FORMAT;
  readonly plugin: string;
  readonly from: string;
  readonly to: string;
  readonly toPublisher: string;
  readonly issuedAt: number;
}

export interface SignedRotation extends RotationBody {
  readonly signature: string;
}

export interface RevocationBody {
  readonly format: typeof REVOCATION_FORMAT;
  readonly publisher: string;
  readonly plugin?: string;
  readonly version?: string;
  readonly reason: string;
  readonly issuedAt: number;
}

export interface SignedRevocation extends RevocationBody {
  readonly signature: string;
}

function asPrivate(key: KeyObject | string | Uint8Array): KeyObject {
  if (typeof key !== 'string' && !ArrayBuffer.isView(key)) return key;
  return loadPrivateKey(key);
}

function asPublic(key: KeyObject | string | Uint8Array): KeyObject {
  if (typeof key !== 'string' && !ArrayBuffer.isView(key)) return key;
  return loadPublicKey(key);
}

function signBody(body: object, privateKey: KeyObject | string | Uint8Array): string {
  return ed25519Sign(null, Buffer.from(canonicalBytes(body)), asPrivate(privateKey)).toString('base64');
}

function verifyBody(body: object, signature: string, publicKey: KeyObject): boolean {
  return ed25519Verify(null, Buffer.from(canonicalBytes(body)), publicKey, Buffer.from(signature, 'base64'));
}

export function signRotation(body: RotationBody, oldPrivateKey: KeyObject | string | Uint8Array): SignedRotation {
  if (body.format !== ROTATION_FORMAT) throw new StatementError('invalid-rotation', 'wrong format');
  return { ...body, signature: signBody(body, oldPrivateKey) };
}

export function verifyRotation(signed: SignedRotation, oldPublicKey: KeyObject | string | Uint8Array): string {
  const { signature, ...body } = signed;
  let key: KeyObject;
  try {
    key = asPublic(oldPublicKey);
  } catch {
    throw new StatementError('invalid-publisher-key', 'old publisher key is not valid');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new KeyError('expected Ed25519');
  if (!verifyBody(body, signature, key))
    throw new StatementError('signature-mismatch', 'rotation signature does not match the old key');
  const from = publisherFingerprint(key);
  if (from !== body.from)
    throw new StatementError('publisher-key-changed', 'rotation from-fingerprint does not match the old key');
  const to = publisherFingerprint(createPublicKey(body.toPublisher));
  if (to !== body.to)
    throw new StatementError('publisher-key-changed', 'rotation to-fingerprint does not match toPublisher');
  return to;
}

export function signRevocation(body: RevocationBody, privateKey: KeyObject | string | Uint8Array): SignedRevocation {
  if (body.format !== REVOCATION_FORMAT) throw new StatementError('invalid-revocation', 'wrong format');
  return { ...body, signature: signBody(body, privateKey) };
}

export function verifyRevocation(signed: SignedRevocation, publicKey: KeyObject | string | Uint8Array): string {
  const { signature, ...body } = signed;
  const key = asPublic(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new KeyError('expected Ed25519');
  if (!verifyBody(body, signature, key)) {
    throw new StatementError('signature-mismatch', 'revocation signature does not match');
  }
  const fingerprint = publisherFingerprint(key);
  if (fingerprint !== body.publisher) {
    throw new StatementError('publisher-key-changed', 'revocation publisher does not match the supplied key');
  }
  return fingerprint;
}

import { sign as ed25519Sign, type KeyObject } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalBytes } from './canonical.ts';
import { INTEGRITY_FILE, SIGNATURE_FILE } from './layout.ts';
import { type IntegrityManifest, manifestJson } from './manifest.ts';

export function signManifest(manifest: IntegrityManifest, privateKey: KeyObject): Uint8Array {
  return ed25519Sign(null, Buffer.from(canonicalBytes(manifest)), privateKey);
}

export function writeSigned(root: string, manifest: IntegrityManifest, privateKey: KeyObject): Uint8Array {
  const sig = signManifest(manifest, privateKey);
  writeFileSync(join(root, INTEGRITY_FILE), manifestJson(manifest));
  writeFileSync(join(root, SIGNATURE_FILE), sig);
  return sig;
}

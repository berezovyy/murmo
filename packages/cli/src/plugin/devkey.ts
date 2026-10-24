// The local development key: signs the plugins a user adds from a folder on
// this machine (`murmo plugin add ./hello`), so the local authoring loop
// needs no hand-made key and no signed archive. It never signs anything a
// registry, git or archive install accepts by itself: those keep needing an
// independently supplied --trust-key (D2). It lives in Murmo's private data
// folder, which anyone able to replace it could already rewrite.

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPrivateKey, publicFromPrivate, publisherFingerprint } from '@murmo/integrity';
import type { StoreRoots } from '@murmo/store';

export interface DevKey {
  readonly privateKey: KeyObject;
  /** The public key, for `--trust-key` on another machine. */
  readonly publicPath: string;
  readonly fingerprint: string;
  /** True when this call made the key. */
  readonly created: boolean;
}

export function devKey(roots: StoreRoots): DevKey {
  const privatePath = join(roots.data, 'plugin-dev-key.pem');
  const publicPath = join(roots.data, 'plugin-dev-key.pub');
  let created = false;
  if (!existsSync(privatePath)) {
    mkdirSync(roots.data, { recursive: true, mode: 0o700 });
    const pair = generateKeyPairSync('ed25519');
    writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    created = true;
  }
  const privateKey = loadPrivateKey(readFileSync(privatePath));
  const publicKey = publicFromPrivate(privateKey);
  if (!existsSync(publicPath)) {
    writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  }
  return { privateKey, publicPath, fingerprint: publisherFingerprint(publicKey), created };
}

// Trust-anchor seam: the verifying key is supplied by the caller (install.sh,
// MURMO_TRUST_KEY, or --key). It is never read from the tarball being checked
// and never injected into cli.mjs (docs/plan/26, four-layer design, E4).

import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fingerprint, keyIdOf, loadPublicKey } from './key.ts';

export type TrustSource = 'env' | 'flag' | 'install-script' | 'explicit';

export interface TrustAnchor {
  readonly publicKey: KeyObject;
  readonly keyId: string;
  readonly fingerprint: string;
  readonly source: TrustSource;
}

export function trustAnchorFromPem(pem: string | Uint8Array, source: TrustSource = 'explicit'): TrustAnchor {
  const publicKey = loadPublicKey(pem);
  return { publicKey, keyId: keyIdOf(publicKey), fingerprint: fingerprint(publicKey), source };
}

export function trustAnchorFromFile(path: string, source: TrustSource = 'flag'): TrustAnchor {
  return trustAnchorFromPem(readFileSync(path), source);
}

/**
 * Resolves the verifying key from outside the package: `--key` / `path`, then
 * `MURMO_TRUST_KEY`. Returns undefined when none is set so the CLI can still
 * print `keyId` from integrity.json for a human to compare.
 */
export function loadTrustAnchor(options: { keyPath?: string; env?: NodeJS.ProcessEnv } = {}): TrustAnchor | undefined {
  const env = options.env ?? process.env;
  if (options.keyPath) return trustAnchorFromFile(options.keyPath, 'flag');
  const fromEnv = env.MURMO_TRUST_KEY;
  if (fromEnv) return trustAnchorFromFile(fromEnv, 'env');
  return undefined;
}

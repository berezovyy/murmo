import { verify as ed25519Verify, type KeyObject } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalBytes, canonicalJson } from './canonical.ts';
import { fingerprint, keyIdOf, loadPublicKey } from './key.ts';
import { INTEGRITY_FILE, SIGNATURE_FILE } from './layout.ts';
import { fileByPath, type IntegrityManifest, isMetaFile, parseManifest, sha256Bytes } from './manifest.ts';

export type VerifyProblem =
  | 'missing-manifest'
  | 'missing-signature'
  | 'unreadable-manifest'
  | 'not-canonical'
  | 'bad-signature'
  | 'key-mismatch'
  | 'missing-file'
  | 'extra-file'
  | 'hash-mismatch'
  | 'size-mismatch'
  | 'mode-mismatch';

export class VerifyError extends Error {
  readonly problem: VerifyProblem;
  readonly path?: string;
  constructor(problem: VerifyProblem, message: string, path?: string) {
    super(message);
    this.name = 'VerifyError';
    this.problem = problem;
    if (path !== undefined) this.path = path;
  }
}

export interface VerifyResult {
  readonly ok: true;
  readonly manifest: IntegrityManifest;
  readonly authenticated: boolean;
  readonly keyId: string;
  readonly fingerprint?: string;
}

export interface VerifyOptions {
  /** Required for authenticity. Without it, only bit-rot of listed files is caught (E4). */
  readonly publicKey?: KeyObject | string | Uint8Array;
  /** When true, a missing helper is reported as `missing-file` even if unlisted. */
  readonly requireHelpers?: readonly string[];
}

/**
 * Checks a packed payload. Never writes, so HOME cannot change (r12 I4 / E3).
 * Signature check needs a key that did not come from this directory.
 */
export function verifyPackage(root: string, options: VerifyOptions = {}): VerifyResult {
  const integrityPath = join(root, INTEGRITY_FILE);
  if (!existsSync(integrityPath)) throw new VerifyError('missing-manifest', `${INTEGRITY_FILE} is missing`);
  const raw = readFileSync(integrityPath);
  let manifest: IntegrityManifest;
  try {
    manifest = parseManifest(JSON.parse(raw.toString('utf8')));
  } catch (error) {
    throw new VerifyError('unreadable-manifest', error instanceof Error ? error.message : String(error));
  }
  const canonical = Buffer.from(canonicalBytes(manifest));
  const trimmed = raw[raw.length - 1] === 0x0a ? raw.subarray(0, raw.length - 1) : raw;
  if (trimmed.toString('utf8') !== canonicalJson(manifest)) {
    throw new VerifyError('not-canonical', `${INTEGRITY_FILE} is not in canonical form`);
  }

  const sigPath = join(root, SIGNATURE_FILE);
  if (!existsSync(sigPath)) throw new VerifyError('missing-signature', `${SIGNATURE_FILE} is missing`);
  const signature = readFileSync(sigPath);

  let authenticated = false;
  let fp: string | undefined;
  if (options.publicKey !== undefined) {
    const publicKey = isKeyObject(options.publicKey) ? options.publicKey : loadPublicKey(options.publicKey);
    const id = keyIdOf(publicKey);
    if (id !== manifest.keyId) {
      throw new VerifyError('key-mismatch', `keyId ${manifest.keyId} does not match trust-anchor ${id}`);
    }
    if (!ed25519Verify(null, canonical, publicKey, signature)) {
      throw new VerifyError(
        'bad-signature',
        `${SIGNATURE_FILE} does not match ${INTEGRITY_FILE} under the trust-anchor key`,
      );
    }
    authenticated = true;
    fp = fingerprint(publicKey);
  }

  const listed = new Set(manifest.files.map((f) => f.path));
  for (const rel of walkFiles(root)) {
    if (isMetaFile(rel)) continue;
    if (!listed.has(rel)) throw new VerifyError('extra-file', `${rel} is not in ${INTEGRITY_FILE}`, rel);
  }
  for (const file of manifest.files) {
    const path = join(root, file.path);
    if (!existsSync(path)) throw new VerifyError('missing-file', `${file.path} is listed but missing`, file.path);
    const st = statSync(path);
    const bytes = readFileSync(path);
    if (bytes.byteLength !== file.size) {
      throw new VerifyError(
        'size-mismatch',
        `${file.path} is ${bytes.byteLength} bytes, manifest says ${file.size}`,
        file.path,
      );
    }
    const digest = sha256Bytes(bytes);
    if (digest !== file.sha256) {
      throw new VerifyError('hash-mismatch', `${file.path} SHA-256 ${digest} != ${file.sha256}`, file.path);
    }
    if ((st.mode & 0o777) !== file.mode) {
      throw new VerifyError(
        'mode-mismatch',
        `${file.path} mode ${(st.mode & 0o777).toString(8)} != ${file.mode.toString(8)}`,
        file.path,
      );
    }
  }
  for (const helper of options.requireHelpers ?? []) {
    if (!fileByPath(manifest, helper) || !existsSync(join(root, helper))) {
      throw new VerifyError('missing-file', `required helper ${helper} is missing`, helper);
    }
  }
  return { ok: true, manifest, authenticated, keyId: manifest.keyId, ...(fp ? { fingerprint: fp } : {}) };
}

function isKeyObject(value: KeyObject | string | Uint8Array): value is KeyObject {
  return typeof value === 'object' && value !== null && 'asymmetricKeyType' in value && !ArrayBuffer.isView(value);
}

function walkFiles(dir: string, rel = '', out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === '.DS_Store') continue;
    const child = rel ? `${rel}/${name}` : name;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkFiles(path, child, out);
    else out.push(child);
  }
  return out;
}

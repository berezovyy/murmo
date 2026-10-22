// Signed plugin distribution envelope (`murmo.json`). Ed25519 over RFC 8785
// JCS of the envelope without `signature` (phase 26 encoder, phase 28 wire).
// Publisher fingerprint is SHA-256 of the full SPKI DER, not the 32-byte raw
// key used for the core-package trust anchor.

import { createHash, createPublicKey, sign as ed25519Sign, verify as ed25519Verify, type KeyObject } from 'node:crypto';
import {
  API_VERSION,
  LIMITS,
  PERMISSIONS,
  type Permission,
  type PluginManifest,
  satisfies,
  validateManifest,
} from '@murmo/api';
import { canonicalBytes } from './canonical.ts';
import { KeyError, loadPrivateKey, loadPublicKey } from './key.ts';
import { sha256Bytes } from './manifest.ts';

export const ENVELOPE_FORMAT = 'murmo-plugin-v1';
export const ENVELOPE_FILE = 'murmo.json';
export const PLUGIN_MANIFEST_FILE = 'murmo.plugin.json';

export const ARCHIVE_COMPRESSED_MAX = 2 * 1024 * 1024;
export const ARCHIVE_EXPANDED_MAX = 4 * 1024 * 1024;
export const ARCHIVE_ENTRY_MAX = 1 * 1024 * 1024;

const PERMISSION_NAMES: ReadonlySet<string> = new Set(PERMISSIONS);
const PLUGIN_ID = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]{0,63}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type EnvelopeErrorCode =
  | 'invalid-manifest'
  | 'invalid-permissions'
  | 'invalid-storage-version'
  | 'invalid-migration'
  | 'invalid-publisher-key'
  | 'signature-mismatch'
  | 'unsigned-files'
  | 'file-digest-mismatch'
  | 'entry-missing'
  | 'manifest-source-size-limit'
  | 'portable-manifest-mismatch'
  | 'incompatible-api';

export class EnvelopeError extends Error {
  readonly code: EnvelopeErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: EnvelopeErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'EnvelopeError';
    this.code = code;
    this.details = details;
  }
}

export interface EnvelopeMigration {
  readonly from: number;
  readonly rename: Readonly<Record<string, string>>;
}

export interface PluginEnvelope {
  readonly format: typeof ENVELOPE_FORMAT;
  readonly id: string;
  readonly version: string;
  readonly sequence: number;
  readonly publisher: string;
  readonly entry: string;
  readonly api: string;
  readonly permissions: readonly Permission[];
  readonly reasons: Readonly<Record<string, string>>;
  readonly storageVersion: number;
  readonly files: Readonly<Record<string, string>>;
  readonly migration?: EnvelopeMigration;
}

export interface SignedEnvelope extends PluginEnvelope {
  readonly signature: string;
}

export interface InspectedPlugin {
  readonly envelope: PluginEnvelope;
  readonly portable: PluginManifest;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly digest: string;
  readonly publisher: string;
  readonly signature: string;
}

function fail(code: EnvelopeErrorCode, message: string, details: Record<string, unknown> = {}): never {
  throw new EnvelopeError(code, message, details);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

/** True when `rel` is a relative POSIX path with no traversal, NUL or backslash. */
export function safeRelPath(rel: string): boolean {
  return (
    typeof rel === 'string' &&
    rel.length > 0 &&
    rel.length < 256 &&
    !rel.startsWith('/') &&
    !rel.includes('\\') &&
    !rel.includes('\0') &&
    rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/** SHA-256 of the Ed25519 SPKI DER (plan 28). Distinct from the core-package fingerprint. */
function asKey(value: KeyObject | string | Uint8Array, kind: 'public' | 'private'): KeyObject {
  if (typeof value !== 'string' && !ArrayBuffer.isView(value)) return value;
  const pem = typeof value === 'string' ? value : value;
  return kind === 'public' ? loadPublicKey(pem) : loadPrivateKey(pem);
}

export function publisherFingerprint(publicKey: KeyObject | string | Uint8Array): string {
  const key = asKey(publicKey, 'public');
  if (key.asymmetricKeyType !== 'ed25519') throw new KeyError(`expected Ed25519, got ${key.asymmetricKeyType}`);
  const der = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

export function envelopeBytes(envelope: PluginEnvelope): Uint8Array {
  return canonicalBytes(envelope);
}

export function signEnvelope(envelope: PluginEnvelope, privateKey: KeyObject | string | Uint8Array): SignedEnvelope {
  const key = asKey(privateKey, 'private');
  const signature = ed25519Sign(null, Buffer.from(envelopeBytes(envelope)), key).toString('base64');
  return { ...envelope, signature };
}

function parseMigration(value: unknown): EnvelopeMigration {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.from) || (value.from as number) < 1) {
    fail('invalid-migration', 'migration.from must be a positive integer');
  }
  if (!isPlainObject(value.rename)) fail('invalid-migration', 'migration.rename must be an object');
  const rename: Record<string, string> = {};
  for (const [from, to] of Object.entries(value.rename)) {
    if (
      typeof to !== 'string' ||
      !to ||
      from === '__proto__' ||
      to === '__proto__' ||
      to === 'constructor' ||
      to === 'prototype'
    ) {
      fail('invalid-migration', 'invalid migration key', { from, to });
    }
    rename[from] = to;
  }
  return { from: value.from as number, rename };
}

export function parseEnvelope(value: unknown): SignedEnvelope {
  if (!isPlainObject(value)) fail('invalid-manifest', 'envelope must be a JSON object');
  const signature = value.signature;
  if (typeof signature !== 'string' || !signature) fail('signature-mismatch', 'envelope signature is missing');
  const body = { ...value };
  delete body.signature;
  if (body.format !== ENVELOPE_FORMAT) fail('invalid-manifest', 'unsupported envelope format', { format: body.format });
  if (typeof body.id !== 'string' || !PLUGIN_ID.test(body.id))
    fail('invalid-manifest', 'invalid plugin id', { id: body.id });
  if (typeof body.version !== 'string' || !STABLE_VERSION.test(body.version)) {
    fail('invalid-manifest', 'plugin version must be stable MAJOR.MINOR.PATCH', { version: body.version });
  }
  if (!Number.isSafeInteger(body.sequence) || (body.sequence as number) < 1) {
    fail('invalid-manifest', 'sequence must be a positive integer');
  }
  if (typeof body.publisher !== 'string' || !body.publisher.includes('BEGIN PUBLIC KEY')) {
    fail('invalid-publisher-key', 'publisher must be an Ed25519 SPKI PEM');
  }
  if (typeof body.entry !== 'string' || !safeRelPath(body.entry) || !body.entry.endsWith('.mjs')) {
    fail('invalid-manifest', 'entry must be a relative .mjs path');
  }
  if (typeof body.api !== 'string' || !body.api.trim()) fail('invalid-manifest', 'api range is required');
  try {
    satisfies(API_VERSION, body.api);
  } catch (error) {
    fail('invalid-manifest', error instanceof Error ? error.message : 'invalid api range', { api: body.api });
  }
  if (!Array.isArray(body.permissions) || new Set(body.permissions).size !== body.permissions.length) {
    fail('invalid-permissions', 'permissions must be a unique array');
  }
  const reasonsIn = body.reasons;
  if (!isPlainObject(reasonsIn)) fail('invalid-permissions', 'reasons must be an object');
  const permissions: Permission[] = [];
  for (const name of body.permissions) {
    if (typeof name !== 'string' || !PERMISSION_NAMES.has(name)) {
      fail('invalid-permissions', `unknown permission ${String(name)}`);
    }
    const reason = reasonsIn[name];
    if (typeof reason !== 'string' || !reason.trim()) {
      fail('invalid-permissions', `permission ${name} needs a reason`);
    }
    permissions.push(name as Permission);
  }
  if (!Number.isSafeInteger(body.storageVersion) || (body.storageVersion as number) < 1) {
    fail('invalid-storage-version', 'storageVersion must be a positive integer');
  }
  if (!isPlainObject(body.files) || Object.keys(body.files).length === 0)
    fail('invalid-manifest', 'files map is required');
  const files: Record<string, string> = {};
  for (const [rel, hash] of Object.entries(body.files)) {
    if (!safeRelPath(rel) || rel === ENVELOPE_FILE || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      fail('invalid-manifest', 'invalid file digest entry', { file: rel });
    }
    files[rel] = hash;
  }
  const envelope: PluginEnvelope = {
    format: ENVELOPE_FORMAT,
    id: body.id,
    version: body.version,
    sequence: body.sequence as number,
    publisher: body.publisher,
    entry: body.entry,
    api: body.api,
    permissions,
    reasons: Object.fromEntries(permissions.map((name) => [name, reasonsIn[name] as string])),
    storageVersion: body.storageVersion as number,
    files,
    ...(own(body, 'migration') ? { migration: parseMigration(body.migration) } : {}),
  };
  if (envelope.migration && envelope.migration.from >= envelope.storageVersion) {
    fail('invalid-migration', 'migration.from must be below storageVersion');
  }
  return { ...envelope, signature };
}

export function verifyEnvelopeSignature(envelope: PluginEnvelope, signature: string, publicKey?: KeyObject): string {
  let key: KeyObject;
  try {
    key = publicKey ?? createPublicKey(envelope.publisher);
  } catch {
    fail('invalid-publisher-key', 'publisher PEM is not a valid public key');
  }
  if (key.asymmetricKeyType !== 'ed25519') fail('invalid-publisher-key', 'publisher key must be Ed25519');
  if (!ed25519Verify(null, Buffer.from(envelopeBytes(envelope)), key, Buffer.from(signature, 'base64'))) {
    fail('signature-mismatch', 'envelope signature does not match publisher key');
  }
  return publisherFingerprint(key);
}

export function inspectPluginFiles(
  files: Readonly<Record<string, Uint8Array>>,
  archiveDigest: string,
): InspectedPlugin {
  const raw = files[ENVELOPE_FILE];
  if (!raw) fail('invalid-manifest', 'murmo.json is missing');
  if (raw.byteLength > LIMITS.manifestBytes) {
    fail('manifest-source-size-limit', `murmo.json is ${raw.byteLength} bytes; the limit is ${LIMITS.manifestBytes}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch {
    fail('invalid-manifest', 'murmo.json is not valid JSON');
  }
  const signed = parseEnvelope(parsed);
  const { signature, ...envelope } = signed;
  const publisher = verifyEnvelopeSignature(envelope, signature);

  const names = Object.keys(files)
    .filter((name) => name !== ENVELOPE_FILE)
    .sort();
  const signedNames = Object.keys(envelope.files).sort();
  if (JSON.stringify(names) !== JSON.stringify(signedNames)) {
    fail('unsigned-files', 'archive files do not match the signed file list', { files: names, signed: signedNames });
  }
  for (const name of names) {
    const bytes = files[name] as Uint8Array;
    if (sha256Bytes(bytes) !== envelope.files[name])
      fail('file-digest-mismatch', `digest mismatch for ${name}`, { file: name });
  }
  const entry = files[envelope.entry];
  if (!entry) fail('entry-missing', `entry ${envelope.entry} is missing`);
  const portableBytes = files[PLUGIN_MANIFEST_FILE];
  if (!portableBytes || entry.byteLength > LIMITS.sourceBytes || portableBytes.byteLength > LIMITS.manifestBytes) {
    fail('manifest-source-size-limit', 'entry or murmo.plugin.json exceeds the source/manifest limit');
  }
  let portable: PluginManifest;
  try {
    portable = validateManifest(JSON.parse(Buffer.from(portableBytes).toString('utf8')));
  } catch (error) {
    fail('portable-manifest-mismatch', error instanceof Error ? error.message : 'invalid murmo.plugin.json');
  }
  const declared = envelope.permissions.map((name) => ({ name, reason: envelope.reasons[name] as string }));
  if (
    portable.name !== envelope.id ||
    portable.version !== envelope.version ||
    portable.api !== envelope.api ||
    portable.entry !== envelope.entry ||
    JSON.stringify(portable.permissions) !== JSON.stringify(declared)
  ) {
    fail('portable-manifest-mismatch', 'murmo.plugin.json does not match the signed envelope');
  }
  return { envelope, portable, files, digest: archiveDigest, publisher, signature };
}

export function assertApiCompatible(apiRange: string, core: string = API_VERSION): void {
  if (!satisfies(core, apiRange)) {
    fail('incompatible-api', `plugin targets API ${apiRange}; this core implements ${core}`, {
      plugin: apiRange,
      core,
    });
  }
}

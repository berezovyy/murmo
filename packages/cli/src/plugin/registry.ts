// Signed plugin registry index. The index is a listing, not a trust anchor:
// it never grants permissions and never replaces the publisher key (plan 33).
// Search is local after a GET of the index URL; the query never leaves the machine.

import { sign as ed25519Sign, verify as ed25519Verify, type KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareVersions, parseVersion } from '@murmo/api';
import {
  canonicalBytes,
  ENVELOPE_FILE,
  type InspectedPlugin,
  loadPrivateKey,
  loadPublicKey,
  publisherFingerprint,
  sha256Bytes,
} from '@murmo/integrity';
import { registryIndexPath, registryMetaPath, type StoreRoots } from '@murmo/store';
import {
  type DistributionLedger,
  ensurePrivateDir,
  type RevocationRecord,
  readStoreFile,
  writeAtomic,
} from '@murmo/store/node';
import { fail } from './errors.ts';
import type { SourceGet } from './sources.ts';

export const INDEX_FORMAT = 'murmo-registry-index-v1';
export const INDEX_MAX_BYTES = 1_048_576;
export const INDEX_FETCH_MS = 24 * 60 * 60 * 1000;

const PLUGIN_ID = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]{0,63}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;

export interface IndexPermission {
  readonly name: string;
  readonly reason: string;
}

export interface IndexCapabilities {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export interface IndexVersion {
  readonly version: string;
  readonly api: string;
  readonly source: string;
  readonly envelope_sha256: string;
  readonly archives: Readonly<Record<string, string>>;
  readonly permissions: readonly IndexPermission[];
  readonly capabilities: IndexCapabilities;
  readonly license: string;
  readonly listed_at: string;
}

export interface IndexRevocation {
  readonly version?: string;
  readonly reason: string;
  readonly at: string;
}

export interface IndexPublisher {
  readonly name: string;
  readonly spki_sha256: string;
  readonly keys: readonly string[];
}

export interface IndexPlugin {
  readonly id: string;
  readonly publisher: IndexPublisher;
  readonly versions: readonly IndexVersion[];
  readonly revoked?: readonly IndexRevocation[];
}

export interface RegistryIndexBody {
  readonly format: typeof INDEX_FORMAT;
  readonly version: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly plugins: readonly IndexPlugin[];
}

export interface SignedRegistryIndex extends RegistryIndexBody {
  readonly signature: string;
}

export interface RegistryMeta {
  readonly schema: 1;
  readonly version: number;
  readonly fetchedAt: number;
  readonly url: string;
  readonly fingerprint: string;
}

export interface RegistryLoadOptions {
  readonly roots: StoreRoots;
  readonly url: string;
  readonly publicKey: string | Uint8Array | KeyObject;
  readonly get?: SourceGet['get'];
  readonly now?: () => number;
  readonly refresh?: boolean;
  readonly offline?: boolean;
}

export interface RegistryLoad {
  readonly index: SignedRegistryIndex;
  readonly fingerprint: string;
  readonly fetched: boolean;
  readonly expired: boolean;
  readonly url: string;
}

export interface RegistryTarget {
  readonly id: string;
  readonly version?: string;
}

export interface ListedVersion {
  readonly plugin: IndexPlugin;
  readonly version: IndexVersion;
}

function asPrivate(key: KeyObject | string | Uint8Array): KeyObject {
  if (typeof key !== 'string' && !ArrayBuffer.isView(key)) return key;
  return loadPrivateKey(key);
}

function asPublic(key: KeyObject | string | Uint8Array): KeyObject {
  if (typeof key !== 'string' && !ArrayBuffer.isView(key)) return key;
  return loadPublicKey(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) fail('registry-index-untrusted', { field });
  return value;
}

function asInt(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('registry-index-untrusted', { field });
  return value as number;
}

function asStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail('registry-index-untrusted', { field });
  }
  return [...(value as string[])];
}

export function parseArchiveDigest(value: string): string {
  const hex = value.startsWith('sha256:') ? value.slice(7) : value;
  if (!HEX64.test(hex)) fail('registry-index-untrusted', { digest: value });
  return hex;
}

export function formatArchiveDigest(hex: string): string {
  return `sha256:${parseArchiveDigest(hex)}`;
}

export function envelopeSha256(inspected: InspectedPlugin): string {
  const raw = inspected.files[ENVELOPE_FILE];
  if (!raw) fail('envelope-digest-mismatch', { reason: 'missing-envelope' });
  return sha256Bytes(raw);
}

function parsePermission(value: unknown): IndexPermission {
  if (!isPlainObject(value)) fail('registry-index-untrusted', { field: 'permissions' });
  return { name: asString(value.name, 'permission.name'), reason: asString(value.reason, 'permission.reason') };
}

function parseVersionEntry(value: unknown): IndexVersion {
  if (!isPlainObject(value)) fail('registry-index-untrusted', { field: 'versions' });
  const version = asString(value.version, 'version');
  if (!STABLE_VERSION.test(version)) fail('registry-index-untrusted', { version });
  if (!isPlainObject(value.archives) || Object.keys(value.archives).length === 0) {
    fail('registry-index-untrusted', { field: 'archives' });
  }
  const archives: Record<string, string> = {};
  for (const [kind, digest] of Object.entries(value.archives)) {
    if (typeof digest !== 'string') fail('registry-index-untrusted', { field: 'archives' });
    parseArchiveDigest(digest);
    archives[kind] = digest;
  }
  const caps = isPlainObject(value.capabilities) ? value.capabilities : {};
  const listedAt = asString(value.listed_at, 'listed_at');
  if (!ISO_DATE.test(listedAt)) fail('registry-index-untrusted', { field: 'listed_at' });
  if (!Array.isArray(value.permissions)) fail('registry-index-untrusted', { field: 'permissions' });
  return {
    version,
    api: asString(value.api, 'api'),
    source: asString(value.source, 'source'),
    envelope_sha256: parseArchiveDigest(asString(value.envelope_sha256, 'envelope_sha256')),
    archives,
    permissions: value.permissions.map(parsePermission),
    capabilities: {
      required: asStringList(caps.required ?? [], 'capabilities.required'),
      optional: asStringList(caps.optional ?? [], 'capabilities.optional'),
    },
    license: asString(value.license, 'license'),
    listed_at: listedAt,
  };
}

function parseRevocation(value: unknown): IndexRevocation {
  if (!isPlainObject(value)) fail('registry-index-untrusted', { field: 'revoked' });
  const at = asString(value.at, 'revoked.at');
  if (!ISO_DATE.test(at)) fail('registry-index-untrusted', { field: 'revoked.at' });
  const version = own(value, 'version') ? asString(value.version, 'revoked.version') : undefined;
  if (version && !STABLE_VERSION.test(version)) fail('registry-index-untrusted', { version });
  return {
    reason: asString(value.reason, 'revoked.reason'),
    at,
    ...(version ? { version } : {}),
  };
}

function parsePublisher(value: unknown): IndexPublisher {
  if (!isPlainObject(value)) fail('registry-index-untrusted', { field: 'publisher' });
  const fingerprint = asString(value.spki_sha256, 'publisher.spki_sha256');
  if (!HEX64.test(fingerprint)) fail('registry-index-untrusted', { field: 'publisher.spki_sha256' });
  return {
    name: asString(value.name, 'publisher.name'),
    spki_sha256: fingerprint,
    keys: asStringList(value.keys ?? [], 'publisher.keys'),
  };
}

function parsePlugin(value: unknown): IndexPlugin {
  if (!isPlainObject(value)) fail('registry-index-untrusted', { field: 'plugins' });
  const id = asString(value.id, 'id');
  if (!PLUGIN_ID.test(id)) fail('registry-index-untrusted', { id });
  if (!Array.isArray(value.versions) || value.versions.length === 0) {
    fail('registry-index-untrusted', { field: 'versions', id });
  }
  const revoked = own(value, 'revoked')
    ? Array.isArray(value.revoked)
      ? value.revoked.map(parseRevocation)
      : fail('registry-index-untrusted', { field: 'revoked' })
    : undefined;
  return {
    id,
    publisher: parsePublisher(value.publisher),
    versions: value.versions.map(parseVersionEntry),
    ...(revoked ? { revoked } : {}),
  };
}

export function parseIndex(value: unknown): SignedRegistryIndex {
  if (!isPlainObject(value)) fail('registry-index-untrusted', { reason: 'not-object' });
  if (value.format !== INDEX_FORMAT) fail('registry-index-untrusted', { format: value.format });
  const signature = asString(value.signature, 'signature');
  if (!Array.isArray(value.plugins)) fail('registry-index-untrusted', { field: 'plugins' });
  const issuedAt = value.issuedAt;
  const expiresAt = value.expiresAt;
  if (!Number.isSafeInteger(issuedAt) || (issuedAt as number) < 0) {
    fail('registry-index-untrusted', { field: 'issuedAt' });
  }
  if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < (issuedAt as number)) {
    fail('registry-index-untrusted', { field: 'expiresAt' });
  }
  return {
    format: INDEX_FORMAT,
    version: asInt(value.version, 'version'),
    issuedAt: issuedAt as number,
    expiresAt: expiresAt as number,
    plugins: value.plugins.map(parsePlugin),
    signature,
  };
}

export function signIndex(body: RegistryIndexBody, privateKey: KeyObject | string | Uint8Array): SignedRegistryIndex {
  if (body.format !== INDEX_FORMAT) fail('registry-index-untrusted', { format: body.format });
  const signature = ed25519Sign(null, Buffer.from(canonicalBytes(body)), asPrivate(privateKey)).toString('base64');
  return { ...body, signature };
}

export function verifyIndex(
  signed: SignedRegistryIndex,
  publicKey: KeyObject | string | Uint8Array,
): { fingerprint: string } {
  const { signature, ...body } = signed;
  let key: KeyObject;
  try {
    key = asPublic(publicKey);
  } catch {
    fail('registry-key-mismatch', { reason: 'invalid-key' });
  }
  if (key.asymmetricKeyType !== 'ed25519') fail('registry-key-mismatch', { reason: 'not-ed25519' });
  const ok = ed25519Verify(null, Buffer.from(canonicalBytes(body)), key, Buffer.from(signature, 'base64'));
  if (!ok) fail('registry-index-tampered', { reason: 'signature-mismatch' });
  return { fingerprint: publisherFingerprint(key) };
}

export function indexUrlOf(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('registry-index-unconfigured', { url: raw });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('registry-index-unconfigured', { url: raw });
  }
  if (!url.pathname || url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/index.json`;
  }
  return url;
}

function isPathLike(spec: string, cwd: string): boolean {
  if (spec.startsWith('.') || spec.startsWith('/')) return true;
  if (spec.endsWith('.tgz') || spec.endsWith('.tar') || spec.endsWith('.tar.gz')) return true;
  return existsSync(resolve(cwd, spec));
}

/** Bare `id` / `id@version` (and scoped) go through the index; sources and paths do not. */
export function parseRegistryTarget(spec: string, cwd: string): RegistryTarget | undefined {
  if (spec.startsWith('npm:') || spec.startsWith('git+') || spec.startsWith('http://') || spec.startsWith('https://')) {
    return undefined;
  }
  if (isPathLike(spec, cwd)) return undefined;
  const scoped = spec.startsWith('@');
  const at = spec.lastIndexOf('@');
  const versionAt = scoped ? spec.indexOf('@', 1) : at;
  if (versionAt > 0 && versionAt === at) {
    const id = spec.slice(0, at);
    const version = spec.slice(at + 1);
    if (PLUGIN_ID.test(id) && STABLE_VERSION.test(version)) return { id, version };
  }
  if (PLUGIN_ID.test(spec)) return { id: spec };
  return undefined;
}

export function lookupListed(index: SignedRegistryIndex, target: RegistryTarget): ListedVersion {
  const plugin = index.plugins.find((row) => row.id === target.id);
  if (!plugin) fail('unlisted-plugin', { id: target.id }, `no registry listing for ${target.id}`);
  const revoked = new Set((plugin.revoked ?? []).map((row) => row.version).filter((v): v is string => Boolean(v)));
  const whole = (plugin.revoked ?? []).some((row) => !row.version);
  if (whole) fail('revoked', { id: plugin.id, publisher: plugin.publisher.spki_sha256 });
  const available = plugin.versions.filter((row) => !revoked.has(row.version));
  if (target.version) {
    const version = plugin.versions.find((row) => row.version === target.version);
    if (!version) fail('unlisted-plugin', { id: target.id, version: target.version });
    if (revoked.has(version.version)) fail('revoked', { id: plugin.id, version: version.version });
    return { plugin, version };
  }
  if (!available.length) fail('revoked', { id: plugin.id });
  const sorted = [...available].sort((a, b) => compareVersions(parseVersion(b.version), parseVersion(a.version)));
  return { plugin, version: sorted[0] as IndexVersion };
}

export function searchIndex(index: SignedRegistryIndex, words: readonly string[]): IndexPlugin[] {
  const needles = words.map((word) => word.trim().toLowerCase()).filter((word) => word.length > 0);
  if (!needles.length) return [...index.plugins];
  return index.plugins.filter((plugin) => {
    const hay = haystack(plugin);
    return needles.every((needle) => hay.includes(needle));
  });
}

function haystack(plugin: IndexPlugin): string {
  const parts = [plugin.id, plugin.publisher.name, plugin.publisher.spki_sha256];
  for (const version of plugin.versions) {
    parts.push(
      version.version,
      version.license,
      version.api,
      ...version.permissions.map((p) => `${p.name} ${p.reason}`),
      ...version.capabilities.required,
      ...version.capabilities.optional,
    );
  }
  return parts.join('\n').toLowerCase();
}

export function assertListedArchive(listed: ListedVersion, inspected: InspectedPlugin, kind: string): void {
  if (listed.plugin.id !== inspected.envelope.id) {
    fail('unlisted-plugin', { id: listed.plugin.id, actual: inspected.envelope.id });
  }
  if (listed.version.version !== inspected.envelope.version) {
    fail('unlisted-plugin', { version: listed.version.version, actual: inspected.envelope.version });
  }
  const envelope = envelopeSha256(inspected);
  if (envelope !== listed.version.envelope_sha256) {
    fail('envelope-digest-mismatch', { expected: listed.version.envelope_sha256, actual: envelope });
  }
  const listedDigest = listed.version.archives[kind];
  if (!listedDigest) fail('archive-digest-mismatch', { kind, reason: 'missing-source-digest' });
  const expected = parseArchiveDigest(listedDigest);
  if (expected !== inspected.digest) {
    fail('archive-digest-mismatch', { kind, expected, actual: inspected.digest });
  }
  if (listed.plugin.publisher.spki_sha256 !== inspected.publisher) {
    fail('publisher-key-not-approved', {
      expected: listed.plugin.publisher.spki_sha256,
      actual: inspected.publisher,
    });
  }
}

export function mergeIndexRevocations(ledger: DistributionLedger, index: SignedRegistryIndex): DistributionLedger {
  const existing = new Set(
    (ledger.revocations ?? []).map((row) => `${row.publisher}|${row.plugin ?? ''}|${row.version ?? ''}`),
  );
  const extra: RevocationRecord[] = [];
  for (const plugin of index.plugins) {
    for (const row of plugin.revoked ?? []) {
      const record: RevocationRecord = {
        publisher: plugin.publisher.spki_sha256,
        plugin: plugin.id,
        reason: row.reason,
        issuedAt: Date.parse(row.at) || index.issuedAt,
        signature: index.signature,
        ...(row.version ? { version: row.version } : {}),
      };
      const key = `${record.publisher}|${record.plugin ?? ''}|${record.version ?? ''}`;
      if (!existing.has(key)) {
        existing.add(key);
        extra.push(record);
      }
    }
  }
  if (!extra.length) return ledger;
  return { ...ledger, revocations: [...(ledger.revocations ?? []), ...extra] };
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const read = await readStoreFile(path, INDEX_MAX_BYTES);
  if (read.status !== 'ok') return undefined;
  try {
    return JSON.parse(Buffer.from(read.bytes).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

export async function loadIndex(options: RegistryLoadOptions): Promise<RegistryLoad> {
  const now = (options.now ?? Date.now)();
  const url = indexUrlOf(options.url);
  const cached = await readJson<SignedRegistryIndex>(registryIndexPath(options.roots));
  const meta = await readJson<RegistryMeta>(registryMetaPath(options.roots));
  const fresh = Boolean(
    cached && meta && meta.url === url.href && now - meta.fetchedAt < INDEX_FETCH_MS && !options.refresh,
  );

  if (options.offline) {
    if (!cached) fail('offline-use-reinstall', { reason: 'no-cached-index' });
    const verified = verifyIndex(cached, options.publicKey);
    return {
      index: cached,
      fingerprint: verified.fingerprint,
      fetched: false,
      expired: now > cached.expiresAt,
      url: url.href,
    };
  }

  if (fresh && cached) {
    const verified = verifyIndex(cached, options.publicKey);
    return {
      index: cached,
      fingerprint: verified.fingerprint,
      fetched: false,
      expired: now > cached.expiresAt,
      url: url.href,
    };
  }

  const get = options.get;
  if (!get) fail('fetch-failed', { url: url.href, reason: 'no-transport' });
  const bytes = await get(url);
  if (bytes.byteLength > INDEX_MAX_BYTES) fail('registry-index-too-large', { bytes: bytes.byteLength });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    fail('registry-index-tampered', { reason: 'not-json' });
  }
  const index = parseIndex(parsed);
  const verified = verifyIndex(index, options.publicKey);
  if (meta && index.version < meta.version) {
    fail('registry-index-rollback', { version: index.version, cached: meta.version });
  }
  await ensurePrivateDir(`${options.roots.data}/registry`, options.roots.data);
  await writeAtomic(registryIndexPath(options.roots), `${JSON.stringify(index)}\n`);
  await writeAtomic(
    registryMetaPath(options.roots),
    `${JSON.stringify({
      schema: 1,
      version: index.version,
      fetchedAt: now,
      url: url.href,
      fingerprint: verified.fingerprint,
    } satisfies RegistryMeta)}\n`,
  );
  return {
    index,
    fingerprint: verified.fingerprint,
    fetched: true,
    expired: now > index.expiresAt,
    url: url.href,
  };
}

export function formatSearchLine(plugin: IndexPlugin): string {
  const latest = plugin.versions[plugin.versions.length - 1];
  const permissions = (latest?.permissions ?? []).map((p) => `${p.name}: ${p.reason}`).join('; ');
  const hosts = latest?.capabilities.required.length ? latest.capabilities.required.join(',') : '-';
  return [
    `${plugin.id}${latest ? `@${latest.version}` : ''}  ${plugin.publisher.name}  ${latest?.license ?? ''}`,
    `  publisher ${plugin.publisher.spki_sha256}`,
    `  permissions ${permissions || '(none)'}`,
    `  requires ${hosts}`,
  ].join('\n');
}

export function formatInfo(listed: ListedVersion): string {
  const { plugin, version } = listed;
  const archives = Object.entries(version.archives)
    .map(([kind, digest]) => `${kind}=${digest}`)
    .join(' ');
  const permissions = version.permissions.map((p) => `  ${p.name}: ${p.reason}`).join('\n');
  const revoked = (plugin.revoked ?? []).map((row) => `  ${row.version ?? '*'} ${row.reason}`).join('\n');
  return [
    `${plugin.id}@${version.version}`,
    `publisher ${plugin.publisher.name} ${plugin.publisher.spki_sha256}`,
    `source ${version.source}`,
    `envelope ${version.envelope_sha256}`,
    `archives ${archives}`,
    `license ${version.license}`,
    `api ${version.api}`,
    `requires ${version.capabilities.required.join(',') || '-'}`,
    'permissions',
    permissions || '  (none)',
    'listing is not a grant; add still needs --trust-key and --grant',
    ...(revoked ? ['revoked', revoked] : []),
  ].join('\n');
}

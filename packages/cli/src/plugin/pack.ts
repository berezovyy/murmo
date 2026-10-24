// Build a signed plugin archive: `packFolder` for an author's folder (`murmo
// plugin pack`, `murmo plugin add ./folder`), `packPlugin` for test fixtures.

import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { type Permission, type PluginManifest, validateManifest } from '@murmo/api';
import {
  ENVELOPE_FILE,
  type EnvelopeMigration,
  type InspectedPlugin,
  inspectPluginFiles,
  PLUGIN_MANIFEST_FILE,
  type PluginEnvelope,
  publisherFingerprint,
  sha256Bytes,
  signEnvelope,
} from '@murmo/integrity';
import { packTarGz } from './archive.ts';
import { fail } from './errors.ts';

export interface PackPluginOptions {
  readonly id?: string;
  readonly version?: string;
  readonly sequence?: number;
  readonly api?: string;
  readonly entry?: string;
  readonly permissions?: readonly Permission[];
  readonly reasons?: Readonly<Record<string, string>>;
  readonly origins?: Readonly<Record<string, string>>;
  readonly storageVersion?: number;
  readonly migration?: EnvelopeMigration;
  readonly source?: string;
  readonly extraFiles?: Readonly<Record<string, Uint8Array | string>>;
  readonly privateKey?: KeyObject;
  readonly publisherPem?: string;
  readonly descriptorPermissions?: readonly Permission[];
  readonly postinstall?: boolean;
}

export interface PackedPlugin {
  readonly bytes: Buffer;
  readonly digest: string;
  readonly publisher: string;
  readonly publicPem: string;
  readonly privateKey: KeyObject;
  readonly inspected: InspectedPlugin;
}

const defaultReason = (name: Permission): string => {
  if (name === 'network') return 'Look up team dictionary on a remote service.';
  if (name === 'fs:project-read') return 'Read files inside the approved project.';
  return 'Show a character-count/status for the current prompt.';
};

export function generatePublisher(): { privateKey: KeyObject; publicPem: string; fingerprint: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, publicPem, fingerprint: publisherFingerprint(publicKey) };
}

function pemOf(privateKey: KeyObject, publisherPem?: string): string {
  if (publisherPem) return publisherPem;
  return createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
}

export function packPlugin(options: PackPluginOptions = {}): PackedPlugin {
  const generated = options.privateKey ? undefined : generatePublisher();
  const privateKey = options.privateKey ?? generated?.privateKey;
  if (!privateKey) throw new Error('missing publisher key');
  const publicPem = pemOf(privateKey, options.publisherPem ?? generated?.publicPem);

  const id = options.id ?? 'dist-demo';
  const version = options.version ?? '1.0.0';
  const entry = options.entry ?? 'index.mjs';
  const api = options.api ?? '^2.0.0';
  const permissions = [...(options.permissions ?? ['draft:read'])];
  const reasons = Object.fromEntries(permissions.map((name) => [name, options.reasons?.[name] ?? defaultReason(name)]));
  const origins = {
    ...(permissions.includes('network') ? { network: options.origins?.network ?? 'https://example.test' } : {}),
    ...options.origins,
  };
  const descriptorPermissions = options.descriptorPermissions ?? permissions;
  const storageVersion = options.storageVersion ?? 1;
  const source =
    options.source ??
    `export default () => ({
  name: ${JSON.stringify(id)},
  version: ${JSON.stringify(version)},
  permissions: ${JSON.stringify(descriptorPermissions)},
  async activate() {},
  async onChange(change, ctx) {
    return [{ type: 'status', text: ${JSON.stringify(id)} + ' ' + ctx.draft.text.length, baseVersion: change.draft.version }];
  },
});
`;

  const portable: PluginManifest = {
    name: id,
    version,
    api,
    entry,
    permissions: permissions.map((name) => ({
      name,
      reason: reasons[name] as string,
      ...(Object.hasOwn(origins, name) ? { origin: origins[name as keyof typeof origins] } : {}),
    })),
    capabilities: { required: {}, optional: {} },
    settingsSchema: { type: 'object', properties: {}, additionalProperties: false },
  };

  const files: Record<string, Uint8Array> = {
    [entry]: Buffer.from(source),
    [PLUGIN_MANIFEST_FILE]: Buffer.from(`${JSON.stringify(portable)}\n`),
    'package.json': Buffer.from(
      JSON.stringify({
        name: id,
        version,
        license: 'MIT',
        ...(options.postinstall
          ? { scripts: { postinstall: "node -e \"require('fs').writeFileSync('INSTALL_SCRIPT_RAN','unsafe')\"" } }
          : {}),
      }),
    ),
    LICENSE: Buffer.from('MIT License\n'),
  };
  for (const [name, body] of Object.entries(options.extraFiles ?? {})) {
    files[name] = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  }

  const hashed = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256Bytes(bytes)]));
  const envelope: PluginEnvelope = {
    format: 'murmo-plugin-v1',
    id,
    version,
    sequence: options.sequence ?? 1,
    publisher: publicPem,
    entry,
    api,
    permissions,
    reasons,
    ...(Object.keys(origins).length ? { origins } : {}),
    storageVersion,
    files: hashed,
    ...(options.migration ? { migration: options.migration } : {}),
  };
  const signed = signEnvelope(envelope, privateKey);
  files[ENVELOPE_FILE] = Buffer.from(`${JSON.stringify(signed)}\n`);
  const bytes = packTarGz(files);
  const digest = sha256Bytes(bytes);
  const inspected = inspectPluginFiles({ ...files }, digest);
  return { bytes, digest, publisher: inspected.publisher, publicPem, privateKey, inspected };
}

export interface PackFolderOptions {
  readonly privateKey: KeyObject;
  /** Release sequence; default from the version, so later versions always sort later. */
  readonly sequence?: number;
  /** Keep the installed storage version on a local update (no migration to write). */
  readonly storageVersion?: number;
}

/** `MAJOR.MINOR.PATCH` as one increasing number, the default release sequence. */
export function versionSequence(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return major * 1_000_000 + Math.min(minor, 999) * 1_000 + Math.min(patch, 999) + 1;
}

function readFolderFile(folder: string, rel: string): Buffer {
  const root = realpathSync(folder);
  let real: string;
  try {
    real = realpathSync(join(root, rel));
  } catch {
    fail('entry-missing', { folder, file: rel });
  }
  const inside = relative(root, real);
  if (inside.startsWith('..') || isAbsolute(inside)) fail('unsafe-archive-path', { raw: rel });
  const stat = statSync(real);
  if (!stat.isFile()) fail('archive-type-denied', { raw: rel });
  return readFileSync(real);
}

/** The folder's `murmo.plugin.json`, validated (its name is the plugin ID). */
export function readFolderManifest(folder: string): { manifest: PluginManifest; bytes: Buffer } {
  const bytes = readFolderFile(folder, PLUGIN_MANIFEST_FILE);
  try {
    return { manifest: validateManifest(JSON.parse(bytes.toString('utf8'))), bytes };
  } catch (error) {
    fail('invalid-manifest', {
      file: join(folder, PLUGIN_MANIFEST_FILE),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** True when `source` names a plugin folder rather than an archive or a remote source. */
export function isPluginFolder(source: string): boolean {
  try {
    return statSync(source).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Sign a plugin folder as written by `murmo plugin new`: its manifest and
 * its one self-contained entry module, nothing else (tests, types and
 * README stay out). The envelope repeats the manifest's permissions and
 * reasons, so what the user reviews is what the author wrote.
 */
export function packFolder(folder: string, options: PackFolderOptions): { bytes: Buffer; inspected: InspectedPlugin } {
  const { manifest, bytes: manifestBytes } = readFolderManifest(folder);
  const entryBytes = readFolderFile(folder, manifest.entry);
  const files: Record<string, Uint8Array> = {
    [PLUGIN_MANIFEST_FILE]: manifestBytes,
    [manifest.entry]: entryBytes,
  };
  const permissions = manifest.permissions.map((entry) => entry.name);
  const origins = Object.fromEntries(
    manifest.permissions.flatMap((entry) => (entry.origin ? [[entry.name, entry.origin]] : [])),
  );
  const envelope: PluginEnvelope = {
    format: 'murmo-plugin-v1',
    id: manifest.name,
    version: manifest.version,
    sequence: options.sequence ?? versionSequence(manifest.version),
    publisher: createPublicKey(options.privateKey).export({ type: 'spki', format: 'pem' }).toString(),
    entry: manifest.entry,
    api: manifest.api,
    permissions,
    reasons: Object.fromEntries(manifest.permissions.map((entry) => [entry.name, entry.reason])),
    ...(Object.keys(origins).length ? { origins } : {}),
    storageVersion: options.storageVersion ?? 1,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256Bytes(bytes)])),
  };
  files[ENVELOPE_FILE] = Buffer.from(`${JSON.stringify(signEnvelope(envelope, options.privateKey))}\n`);
  const bytes = packTarGz(files);
  return { bytes, inspected: inspectPluginFiles(files, sha256Bytes(bytes)) };
}

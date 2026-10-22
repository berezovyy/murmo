// Build a signed plugin archive. Tests generate fixtures with this; first-party
// plugins outside the core package use the same envelope.

import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { Permission, PluginManifest } from '@murmo/api';
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

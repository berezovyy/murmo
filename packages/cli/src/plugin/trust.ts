// Publisher pins, version pins, high-water, and the v1 first-party gate.
// A key inside the archive never bootstraps trust (D2). High-water never
// lowers, including on rollback.

import { readFileSync } from 'node:fs';
import { compareVersions, type Permission, parseVersion } from '@murmo/api';
import type { InspectedPlugin } from '@murmo/integrity';
import { loadPublicKey, publisherFingerprint } from '@murmo/integrity';
import type { PublisherIdentity } from '@murmo/store/node';
import { fail } from './errors.ts';

/**
 * SHA-256 of the first-party publisher SPKI DER. Empty until phase 31 ships a
 * key. Phase 32: packed builds accept any independently supplied `--trust-key`;
 * this fingerprint is informational, not an exclusive gate.
 */
export const FIRST_PARTY_PUBLISHER = '';

export interface TrustGate {
  /** SHA-256 of the allowed first-party SPKI DER. */
  readonly firstPartyFingerprint: string;
  /**
   * Always true after phase 32. Kept so older callers still compile.
   * Third-party keys are accepted via `--trust-key` (D2).
   */
  readonly allowThirdParty: boolean;
}

export function thirdPartyMessage(): string {
  return 'supply --trust-key with the publisher public key; a key inside the archive is never enough';
}

export function fingerprintFromKeyFile(path: string): string {
  return publisherFingerprint(loadPublicKey(readFileSync(path)));
}

export function assertPublisherGate(_inspected: InspectedPlugin, _gate: TrustGate): void {
  // Phase 32: the first-party-only packed gate is off. Trust is --trust-key
  // plus the ledger; revocations are checked separately.
}

export function assertTrust(
  inspected: InspectedPlugin,
  identity: PublisherIdentity | undefined,
  trustKeyPath: string | undefined,
  rotationTo?: string,
): void {
  if (!identity) {
    if (!trustKeyPath) {
      fail('publisher-approval-required', { id: inspected.envelope.id, publisher: inspected.publisher });
    }
    const approved = fingerprintFromKeyFile(trustKeyPath);
    if (approved !== inspected.publisher)
      fail('publisher-key-not-approved', { expected: approved, actual: inspected.publisher });
    return;
  }
  if (identity.publisher === inspected.publisher) return;
  if (rotationTo && rotationTo === inspected.publisher) return;
  if (trustKeyPath && fingerprintFromKeyFile(trustKeyPath) === inspected.publisher) return;
  fail('publisher-key-changed', { expected: identity.publisher, actual: inspected.publisher });
}

export function assertPins(
  inspected: InspectedPlugin,
  identity: PublisherIdentity | undefined,
  currentDigest?: string,
): void {
  if (!identity) return;
  const version = inspected.envelope.version;
  const pinned = identity.versions[version];
  if (pinned && pinned !== inspected.digest) {
    fail('version-content-changed', { version, expected: pinned, actual: inspected.digest });
  }
  if (identity.highestVersion) {
    const order = compareVersions(parseVersion(version), parseVersion(identity.highestVersion));
    if (order < 0) fail('downgrade-denied', { version, highestVersion: identity.highestVersion });
  }
  if (inspected.envelope.sequence < identity.highWater) {
    fail('downgrade-denied', { sequence: inspected.envelope.sequence, highWater: identity.highWater });
  }
  if (currentDigest && inspected.envelope.sequence === identity.highWater && inspected.digest !== currentDigest) {
    fail('sequence-reuse-denied', { sequence: inspected.envelope.sequence });
  }
}

export function nextIdentity(inspected: InspectedPlugin, previous: PublisherIdentity | undefined): PublisherIdentity {
  const highest =
    previous?.highestVersion &&
    compareVersions(parseVersion(previous.highestVersion), parseVersion(inspected.envelope.version)) > 0
      ? previous.highestVersion
      : inspected.envelope.version;
  const chain = previous?.chain
    ? previous.publisher === inspected.publisher
      ? previous.chain
      : [...previous.chain, inspected.publisher]
    : previous && previous.publisher !== inspected.publisher
      ? [previous.publisher, inspected.publisher]
      : [inspected.publisher];
  return {
    publisher: inspected.publisher,
    highWater: Math.max(previous?.highWater ?? 0, inspected.envelope.sequence),
    highestVersion: highest,
    versions: { ...previous?.versions, [inspected.envelope.version]: inspected.digest },
    chain,
  };
}

export function isRevoked(
  revocations: readonly { publisher: string; plugin?: string; version?: string }[] | undefined,
  plugin: string,
  publisher: string,
  version?: string,
): boolean {
  if (!revocations?.length) return false;
  return revocations.some((row) => {
    if (row.publisher !== publisher) return false;
    if (row.plugin && row.plugin !== plugin) return false;
    if (row.version && row.version !== version) return false;
    return true;
  });
}

export function missingGrants(declared: readonly Permission[], held: readonly Permission[] | undefined): Permission[] {
  const have = new Set(held ?? []);
  return declared.filter((name) => !have.has(name));
}

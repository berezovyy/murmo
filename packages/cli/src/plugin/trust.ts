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
 * key; release builds still refuse any other publisher (the gate is on).
 */
export const FIRST_PARTY_PUBLISHER = '';

export interface TrustGate {
  /** SHA-256 of the allowed first-party SPKI DER. */
  readonly firstPartyFingerprint: string;
  /**
   * Open only in unpackaged test builds (`MURMO_PLUGIN_TEST=1`). A packed
   * tree (integrity.json present) never honours the override.
   */
  readonly allowThirdParty: boolean;
}

export function thirdPartyMessage(): string {
  return 'third-party plugins are not enabled in this release; authors can use `murmo plugin dev`';
}

export function fingerprintFromKeyFile(path: string): string {
  return publisherFingerprint(loadPublicKey(readFileSync(path)));
}

export function assertPublisherGate(inspected: InspectedPlugin, gate: TrustGate): void {
  if (gate.allowThirdParty) return;
  if (gate.firstPartyFingerprint && inspected.publisher === gate.firstPartyFingerprint) return;
  fail('third-party-disabled', { publisher: inspected.publisher }, thirdPartyMessage());
}

export function assertTrust(
  inspected: InspectedPlugin,
  identity: PublisherIdentity | undefined,
  trustKeyPath: string | undefined,
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
  if (identity.publisher !== inspected.publisher) {
    fail('publisher-key-changed', { expected: identity.publisher, actual: inspected.publisher });
  }
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
  return {
    publisher: inspected.publisher,
    highWater: Math.max(previous?.highWater ?? 0, inspected.envelope.sequence),
    highestVersion: highest,
    versions: { ...previous?.versions, [inspected.envelope.version]: inspected.digest },
  };
}

export function missingGrants(declared: readonly Permission[], held: readonly Permission[] | undefined): Permission[] {
  const have = new Set(held ?? []);
  return declared.filter((name) => !have.has(name));
}

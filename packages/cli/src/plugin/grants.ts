// Grants are never inferred from a signature or a project file. add prints
// every permission with its reason and the archive digest, and needs --grant
// (D3). An update that adds a permission stops with permission-approval-required.

import { HIGH_TRUST_PERMISSIONS, type Permission } from '@murmo/api';
import type { InspectedPlugin } from '@murmo/integrity';
import { fail } from './errors.ts';
import { missingGrants } from './trust.ts';

export const HIGH_TRUST = HIGH_TRUST_PERMISSIONS;

export function highTrustPrompt(name: Permission, reason: string, origin?: string): string {
  if (name === 'network') {
    return `${name} (${origin ?? 'origin required'}): ${reason} Draft text may be sent to this origin.`;
  }
  if (name === 'draft:read:full') {
    return `${name}: ${reason} This plugin will see pasted and filled prompt text, not only what you type.`;
  }
  if (name === 'project:git') {
    return `${name}: ${reason} This plugin can read branch, status, commit subjects and changed paths.`;
  }
  return `${name}: ${reason}`;
}

export function parseGrantList(value: string | undefined): Permission[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0) as Permission[];
}

export function requireGrants(
  inspected: InspectedPlugin,
  granted: readonly Permission[],
  held?: readonly Permission[],
): void {
  const additional = missingGrants(inspected.envelope.permissions, held);
  if (additional.length === 0) return;
  const approved = new Set(granted);
  if (additional.some((name) => !approved.has(name))) {
    fail('permission-approval-required', {
      id: inspected.envelope.id,
      added: additional,
      reasons: Object.fromEntries(additional.map((name) => [name, inspected.envelope.reasons[name]])),
      digest: inspected.digest,
    });
  }
}

export function grantReview(inspected: InspectedPlugin): {
  id: string;
  digest: string;
  publisher: string;
  permissions: readonly { name: Permission; reason: string; highTrust: boolean; origin?: string }[];
} {
  const origins = inspected.envelope.origins ?? {};
  return {
    id: inspected.envelope.id,
    digest: inspected.digest,
    publisher: inspected.publisher,
    permissions: inspected.envelope.permissions.map((name) => {
      const origin = origins[name];
      return {
        name,
        reason: highTrustPrompt(name, inspected.envelope.reasons[name] as string, origin),
        highTrust: (HIGH_TRUST as readonly string[]).includes(name),
        ...(origin ? { origin } : {}),
      };
    }),
  };
}

// Grants are never inferred from a signature or a project file. add prints
// every permission with its reason and the archive digest, and needs --grant
// (D3). An update that adds a permission stops with permission-approval-required.

import type { Permission } from '@murmo/api';
import type { InspectedPlugin } from '@murmo/integrity';
import { fail } from './errors.ts';
import { missingGrants } from './trust.ts';

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
  permissions: readonly { name: Permission; reason: string }[];
} {
  return {
    id: inspected.envelope.id,
    digest: inspected.digest,
    publisher: inspected.publisher,
    permissions: inspected.envelope.permissions.map((name) => ({
      name,
      reason: inspected.envelope.reasons[name] as string,
    })),
  };
}

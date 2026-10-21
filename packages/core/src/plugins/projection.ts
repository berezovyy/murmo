// Typed-only draft projection (2.0-pre). `draft:read` sees non-typed UTF-16
// units as `█`; without host-labeled evidence every unit is masked. Pasted
// secrets stay hidden unless `draft:read:full` is granted (S6, lesson 77).

import type { Change, Draft, InputOriginEvidence, Permission } from '@murmo/api';
import { projectTyped } from '@murmo/provenance';

const emptyDraft: Draft = { text: '', cursor: 0, version: -1, certainty: 'unknown', typedSpans: [] };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function holds(permissions: readonly Permission[], permission: Permission): boolean {
  if (permissions.includes(permission)) return true;
  return permission === 'draft:read' && permissions.includes('draft:read:full');
}

/** The draft a plugin with these granted permissions may see. */
export function projectDraft(draft: Draft, permissions: readonly Permission[], evidence: InputOriginEvidence): Draft {
  if (holds(permissions, 'draft:read:full')) return clone(draft);
  if (!holds(permissions, 'draft:read')) return clone(emptyDraft);
  return projectTyped(draft, evidence);
}

/** A typed-only change: masked drafts and one whole-draft delta, so paste does not leak. */
export function projectChange(
  change: Change,
  permissions: readonly Permission[],
  evidence: InputOriginEvidence,
): Change {
  if (holds(permissions, 'draft:read:full')) return clone(change);
  const draft = projectDraft(change.draft, permissions, evidence);
  const before = change.before ? projectDraft(change.before, permissions, evidence) : undefined;
  return {
    draft,
    origin: change.origin,
    ...(before
      ? { before, deltas: [{ origin: 'unknown' as const, from: 0, to: before.text.length, insert: draft.text }] }
      : {}),
  };
}

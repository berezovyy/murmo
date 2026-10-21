// Typed-only projection of submit and committed text. A `draft:read` plugin
// must not see pasted secrets at send (lesson 80); `draft:read:full` does.

import type { Draft, InputOriginEvidence, Range } from '@murmo/api';
import { projectTyped } from '@murmo/provenance';
import type { PluginEntry } from '../hooks.ts';
import type { SubmitAccess } from './types.ts';

const empty: Draft = { text: '', cursor: 0, version: -1, certainty: 'unknown', typedSpans: [] };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The draft a plugin may see, including a replaced submit body. */
export function projectDraft(
  draft: Draft,
  plugin: PluginEntry,
  access: SubmitAccess,
  evidence: InputOriginEvidence,
): Draft {
  if (access.mayReadFull(plugin)) return clone(draft);
  if (!access.holds(plugin, 'draft:read')) return empty;
  return projectTyped(draft, evidence);
}

/** Committed text as a typed-only reader sees it: spans from the send, not the now-empty composer. */
export function projectCommittedText(
  text: string,
  typedSpans: readonly Range[] | undefined,
  plugin: PluginEntry,
  access: SubmitAccess,
  evidence: InputOriginEvidence,
): string {
  if (access.mayReadFull(plugin)) return text;
  if (!access.holds(plugin, 'draft:read')) return '';
  return projectTyped(
    { text, cursor: text.length, version: 0, certainty: 'authoritative', typedSpans: typedSpans ?? [] },
    evidence,
  ).text;
}

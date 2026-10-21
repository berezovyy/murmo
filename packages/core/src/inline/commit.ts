// Acknowledgement and next-key ledger checks. Only an `applied` receipt whose
// text and cursor match the planned state arms undo and pending-dot (E21).
// Submit never flushes a pending dot (lesson 42; phase 08 hand-off).

import type { Draft, DraftDelta } from '@murmo/api';
import type { InlineCommit, InlineReplay } from '@murmo/api/adapter';
import { applyDeltas, deltaProblem } from '@murmo/provenance';

export const NEXT_KEY_MAX_DELTAS = 256;
export const NEXT_KEY_MAX_UNITS = 65536;

export interface PlannedCommit {
  readonly id: string;
  readonly text: string;
  readonly cursor: number;
  readonly replay: InlineReplay;
}

export function commitArms(planned: PlannedCommit, commit: InlineCommit): boolean {
  return (
    planned.id === commit.transactionId &&
    commit.status === 'applied' &&
    commit.text === planned.text &&
    commit.cursor === planned.cursor
  );
}

/**
 * Replay a next-key backlog onto `before`. Returns the reconstructed text, or
 * null when the ledger is over budget, stale, or does not add up.
 */
export function replayNextKey(
  before: Draft,
  deltas: readonly DraftDelta[],
  atVersion: number,
  now: { readonly text: string; readonly version: number },
): string | null {
  if (atVersion !== now.version) return null;
  if (deltas.length > NEXT_KEY_MAX_DELTAS) return null;
  let units = 0;
  let text = before.text;
  for (const delta of deltas) {
    units += delta.insert.length;
    if (units > NEXT_KEY_MAX_UNITS) return null;
    if (deltaProblem(text, delta)) return null;
    text = applyDeltas(text, [delta]);
  }
  if (text !== now.text) return null;
  return text;
}

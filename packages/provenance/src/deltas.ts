// Ordered draft deltas (draft 1.2): a change carries `before` plus every
// splice in the order the host applied it, each addressing the text the
// previous ones produced. Coalesced change events once hid word boundaries;
// ordered deltas lost nothing across 68,936 ledgers per fuzz cohort (lesson 63,
// r13-platform-core § K1), and the same held for 2.0-pre on Node and Bun.

import type { Draft, DraftDelta, Range } from '@murmo/api';

/** Why a delta cannot apply to `text`, or null when it can. */
export function deltaProblem(text: string, delta: DraftDelta): string | null {
  const { from, to, insert } = delta;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return `delta range [${from}, ${to}) is not integer`;
  if (from < 0 || to < from || to > text.length) return `delta range [${from}, ${to}) is outside [0, ${text.length}]`;
  if (typeof insert !== 'string') return 'delta insert is not a string';
  return null;
}

/** Applies one delta. Throws a RangeError for a delta outside the text, never clamps it. */
export function applyDelta(text: string, delta: DraftDelta): string {
  const problem = deltaProblem(text, delta);
  if (problem) throw new RangeError(problem);
  return text.slice(0, delta.from) + delta.insert + text.slice(delta.to);
}

/** Applies the deltas in order, each to the text the previous ones produced. */
export function applyDeltas(before: string, deltas: readonly DraftDelta[]): string {
  let text = before;
  for (const delta of deltas) text = applyDelta(text, delta);
  return text;
}

/**
 * True when the deltas, applied in order to `before.text`, each fit the text
 * they address and produce exactly `after.text`. A lost, extra or reordered
 * delta fails this; it is the core's intake check for every change (phase 05).
 */
export function verifyLedger(before: Draft, deltas: readonly DraftDelta[], after: Draft): boolean {
  let text = before.text;
  for (const delta of deltas) {
    if (deltaProblem(text, delta)) return false;
    text = text.slice(0, delta.from) + delta.insert + text.slice(delta.to);
  }
  return text === after.text;
}

export type Bias = 'before' | 'after';

/**
 * Where a position ends up after the deltas. Before a delta's range it stays;
 * after it, it shifts; on or inside the replaced range it moves to the start of
 * the insert (`before`) or its end (`after`). A cursor maps with `after`, as in
 * the fake adapter: typing at the cursor leaves it after what was typed.
 */
export function mapPosition(position: number, deltas: readonly DraftDelta[], bias: Bias): number {
  let at = position;
  for (const { from, to, insert } of deltas) {
    if (at < from) continue;
    if (at > to) at += insert.length - (to - from);
    else at = bias === 'after' ? from + insert.length : from;
  }
  return at;
}

/**
 * A range rebased through the deltas, or null once any delta changes text
 * inside it. An insertion exactly at either edge leaves the range intact (it
 * shifts if the insertion is at its start). This is how pending edits and undo
 * records survive later splices (shared-v2/coordinator/inline-rewrite.ts).
 */
export function mapRange(range: Range, deltas: readonly DraftDelta[]): Range | null {
  let [a, b] = range;
  for (const { from, to, insert } of deltas) {
    const shift = insert.length - (to - from);
    if (to <= a) {
      a += shift;
      b += shift;
    } else if (from < b) return null;
    // Otherwise the delta is after the range (or inserts at its end): unchanged.
  }
  return [a, b];
}

/**
 * Merges each delta into the previous one when it is a pure insertion right
 * after the previous delta's insert, from the same origin and plugin. Nothing
 * else merges: a paste between typed keys stays its own delta, so the origin
 * boundary stays visible to every reader.
 */
export function coalesce(deltas: readonly DraftDelta[]): DraftDelta[] {
  const out: DraftDelta[] = [];
  for (const delta of deltas) {
    const last = out[out.length - 1];
    if (
      last &&
      delta.from === delta.to &&
      delta.from === last.from + last.insert.length &&
      delta.origin === last.origin &&
      delta.pluginId === last.pluginId
    ) {
      out[out.length - 1] = { ...last, insert: last.insert + delta.insert };
    } else out.push(delta);
  }
  return out;
}

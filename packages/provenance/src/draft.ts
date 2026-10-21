// The draft after a change: text, cursor, selection and typed spans move
// together, by one rule set that the core and all four adapters share
// (docs/plan/04 § Provenance).

import type { Draft, DraftDelta, InputOriginEvidence, Range } from '@murmo/api';
import { isSingleCodePoint } from '@murmo/text';
import { applyDelta } from './deltas.ts';
import { type Spans, splice, validSpans } from './spans.ts';

/** What the adapter can prove about `typed` deltas. */
export interface TypingRules {
  /** `Capabilities.inputOriginEvidence`. Only `host-labeled` input can add typed coverage (lesson 80). */
  readonly evidence: InputOriginEvidence;
  /**
   * The adapter reports a multi-code-point `typed` delta only for a burst of
   * individual keys (Pi, OpenCode, the Codex wrapper). Claude can't tell a
   * burst from a commit, so its multi-character `typed` text is no proof of
   * typing (lesson 64; experiments/engine-v2/src/provenance.ts).
   */
  readonly keyBursts: boolean;
}

/**
 * True when the delta's insert becomes typed coverage: origin `typed`,
 * host-labeled evidence, and one code point (one key) unless the adapter
 * declares key bursts. Paste, IME, history, native-menu, plugin, undo and
 * unknown input never adds coverage, whatever the text (lessons 12, 52).
 */
export function addsCoverage(delta: DraftDelta, rules: TypingRules): boolean {
  return (
    delta.origin === 'typed' &&
    rules.evidence === 'host-labeled' &&
    delta.insert.length > 0 &&
    (rules.keyBursts || isSingleCodePoint(delta.insert))
  );
}

const hasSelection = (selection: Range | undefined): selection is Range =>
  selection !== undefined && selection[0] !== selection[1];

function withSelection(draft: Omit<Draft, 'selection'>, selection: Range | undefined): Draft {
  return hasSelection(selection) ? { ...draft, selection } : draft;
}

export interface NextDraftOptions extends TypingRules {
  /** How much the version grows; 0 for every delta of a change but the last. Default 1. */
  readonly versionStep?: number;
}

/**
 * The draft after one delta. The cursor maps as in the fake adapter: before the
 * range it stays, after it it shifts, on or inside it it lands at the end of
 * the insert. A selection the delta touches is gone; one it doesn't touch
 * shifts. Spans follow `splice` with `addsCoverage`.
 */
export function nextDraft(draft: Draft, delta: DraftDelta, options: NextDraftOptions): Draft {
  const text = applyDelta(draft.text, delta);
  const { from, to, insert } = delta;
  const shift = insert.length - (to - from);
  const cursor = draft.cursor < from ? draft.cursor : draft.cursor > to ? draft.cursor + shift : from + insert.length;
  let selection = draft.selection;
  if (hasSelection(selection)) {
    const [a, b] = selection;
    if (to < a) selection = [a + shift, b + shift];
    else if (from <= b) selection = undefined;
  }
  return withSelection(
    {
      text,
      cursor,
      version: draft.version + (options.versionStep ?? 1),
      certainty: draft.certainty,
      typedSpans: splice(draft.typedSpans, from, to, insert.length, addsCoverage(delta, options)),
    },
    selection,
  );
}

/** The draft after a whole change: every delta in order, and the version grows by one. */
export function applyChange(draft: Draft, deltas: readonly DraftDelta[], rules: TypingRules): Draft {
  let next = draft;
  deltas.forEach((delta, index) => {
    next = nextDraft(next, delta, { ...rules, versionStep: index === deltas.length - 1 ? 1 : 0 });
  });
  return deltas.length === 0 ? { ...draft, version: draft.version + 1 } : next;
}

function checkPosition(draft: Draft, at: number, what: string): void {
  if (!Number.isInteger(at) || at < 0 || at > draft.text.length) {
    throw new RangeError(`${what} ${at} is outside [0, ${draft.text.length}]`);
  }
}

/** A cursor move or selection change: text and typed spans stay exactly as they were. */
export function moveCursor(draft: Draft, cursor: number, selection?: Range): Draft {
  checkPosition(draft, cursor, 'cursor');
  if (selection) {
    checkPosition(draft, selection[0], 'selection start');
    checkPosition(draft, selection[1], 'selection end');
    if (selection[1] < selection[0]) throw new RangeError('selection is reversed');
  }
  const { selection: _old, ...rest } = draft;
  return withSelection({ ...rest, cursor, version: draft.version + 1 }, selection);
}

/**
 * An undo restore: the saved text, cursor, selection and typed spans, exactly
 * as saved, never recomputed from the restoring delta (which has origin
 * `undo` and so would add no coverage). The version keeps growing.
 */
export function restoreDraft(current: Draft, saved: Draft): Draft {
  const spans: Spans = saved.typedSpans;
  if (!validSpans(spans, saved.text.length)) throw new RangeError('saved typed spans are not valid for the saved text');
  return withSelection(
    {
      text: saved.text,
      cursor: saved.cursor,
      version: current.version + 1,
      certainty: current.certainty,
      typedSpans: spans,
    },
    saved.selection,
  );
}

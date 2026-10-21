// Pure functions over @murmo/provenance for fixtures/provenance/ and the
// ledger generator. A ledger case is a list of changes as an adapter reports
// them (ordered deltas plus the text after), cursor moves, selections and undo
// restores; the result is what the draft looks like after each one.

import type { Draft, DraftDelta, InputOriginEvidence, Range } from '@murmo/api';
import {
  applyChange,
  applyDeltas,
  coalesce,
  covers,
  moveCursor,
  projectTyped,
  restoreDraft,
  type TypingRules,
  verifyLedger,
} from '@murmo/provenance';
import type { PureEntry } from '../pure.ts';

type LedgerChange =
  | { deltas: DraftDelta[]; after: string }
  | { move: number }
  | { select: [number, number] }
  /** Restore the draft as it was after change `undo` (-1: the start). */
  | { undo: number };

interface LedgerInput {
  evidence: InputOriginEvidence;
  keyBursts?: boolean;
  /** Text already in the draft at the start, of unknown origin. */
  text?: string;
  changes: LedgerChange[];
  /** Ranges asked of the final typed spans (correction eligibility). */
  covers?: [number, number][];
}

/** The origin of each delta with consecutive repeats collapsed: what coalescing must preserve. */
const originRuns = (deltas: readonly DraftDelta[]): string =>
  deltas
    .map((d) => d.origin)
    .filter((origin, i, all) => origin !== all[i - 1])
    .join(',');

function ledger(input: unknown): unknown {
  const { evidence, keyBursts = false, text = '', changes, covers: asked } = input as LedgerInput;
  const rules: TypingRules = { evidence, keyBursts };
  const start: Draft = { text, cursor: text.length, version: 0, certainty: 'authoritative', typedSpans: [] };
  const history: Draft[] = [];
  const steps: [number, readonly Range[]][] = [];
  let draft = start;
  let verified = 0;
  let coalesced = 0;
  for (const change of changes) {
    if ('deltas' in change) {
      const reported: Draft = { ...draft, text: change.after };
      if (verifyLedger(draft, change.deltas, reported)) {
        verified++;
        const merged = coalesce(change.deltas);
        if (applyDeltas(draft.text, merged) === change.after && originRuns(merged) === originRuns(change.deltas))
          coalesced++;
        draft = applyChange(draft, change.deltas, rules);
      } else {
        // Spans cannot be mapped through a ledger that doesn't add up: the host's text, no coverage.
        draft = {
          text: change.after,
          cursor: change.after.length,
          version: draft.version + 1,
          certainty: draft.certainty,
          typedSpans: [],
        };
      }
    } else if ('move' in change) draft = moveCursor(draft, change.move);
    else if ('select' in change) draft = moveCursor(draft, change.select[1], change.select);
    else {
      const saved = change.undo < 0 ? start : history[change.undo];
      if (!saved) throw new RangeError(`undo to change ${change.undo}, which has not happened`);
      draft = restoreDraft(draft, saved);
    }
    history.push(draft);
    steps.push([draft.cursor, draft.typedSpans]);
  }
  return {
    steps,
    text: draft.text,
    selection: draft.selection ?? null,
    projected: projectTyped(draft, evidence).text,
    verified,
    coalesced,
    ...(asked ? { covers: asked.map(([from, to]) => covers(draft.typedSpans, from, to)) } : {}),
  };
}

interface ProjectInput {
  draft: { text: string; cursor: number; selection?: [number, number]; typedSpans: [number, number][] };
  evidence: InputOriginEvidence;
}

function project(input: unknown): unknown {
  const { draft, evidence } = input as ProjectInput;
  const view = projectTyped({ ...draft, version: 1, certainty: 'authoritative' }, evidence);
  return {
    text: view.text,
    cursor: view.cursor,
    selection: view.selection ?? null,
    typedSpans: view.typedSpans,
  };
}

export const provenanceFunctions: Readonly<Record<string, PureEntry>> = {
  'provenance.ledger': ledger,
  'provenance.project': project,
  'provenance.coalesce': (input) => coalesce((input as { deltas: DraftDelta[] }).deltas),
};

// Draft intake: the session's view of the draft, kept from the adapter's
// change events. Every change carries `before` plus the ordered deltas since
// the previous one (lesson 63); intake checks that they add up (the ledger
// check from @murmo/provenance) and computes typed spans itself from the
// verified deltas, so "only touch what you typed" rests on one rule set and a
// lost or reordered delta can never leave stale coverage behind.
//
// Changes that arrive while the session's own commit or restore is in flight
// are held, then published in order once the result is known: the change the
// commit itself caused (its echo) is recognized as the session's own, and
// contiguous foreign changes are merged into one change with all their deltas
// (r13-platform-core § K1: merged, never dropped).
//
// A ledger that does not add up is a resync: the adapter's text becomes the
// draft, published as one `unknown` whole-buffer delta, with no typed
// coverage, because nothing about the gap can be proven (phase 04 hand-off).

import type { Change, Draft, DraftDelta, Edit, InputOriginEvidence, Origin } from '@murmo/api';
import { applyChange, applyDelta, type TypingRules, validSpans, verifyLedger } from '@murmo/provenance';

/** One change as the session publishes it to plugins. */
export interface Accepted {
  readonly change: Change;
  /** Caused by the session's own commit or restore: no new key epoch, the undo window stays open. */
  readonly own: boolean;
  /** The ledger did not add up and the draft was resynced from the adapter. */
  readonly resynced: boolean;
}

interface Awaiting {
  readonly version: number;
  readonly text: string;
  readonly origin: Extract<Origin, 'plugin' | 'undo'>;
  readonly pluginId?: string;
}

const isInteger = (value: unknown): value is number => Number.isInteger(value);

function checkDraft(draft: unknown): asserts draft is Draft {
  const d = draft as Partial<Draft> | null;
  if (
    !d ||
    typeof d.text !== 'string' ||
    !isInteger(d.cursor) ||
    !isInteger(d.version) ||
    !Array.isArray(d.typedSpans) ||
    d.cursor < 0 ||
    d.cursor > d.text.length
  ) {
    throw new TypeError('adapter reported a malformed draft');
  }
}

const sameDraft = (a: Draft | undefined, b: Draft): boolean =>
  a !== undefined && a.version === b.version && a.text === b.text;

/** Typed origins are only evidence when the host labels them (lesson 80); otherwise they become `unknown`. */
export function degradeOrigins(change: Change, evidence: InputOriginEvidence): Change {
  if (evidence === 'host-labeled') return change;
  const relabel = <T extends { readonly origin: Origin }>(item: T): T =>
    item.origin === 'typed' ? { ...item, origin: 'unknown' } : item;
  return {
    ...relabel(change),
    draft: { ...change.draft, typedSpans: [] },
    ...(change.before ? { before: { ...change.before, typedSpans: [] } } : {}),
    ...(change.deltas ? { deltas: change.deltas.map(relabel) } : {}),
  };
}

/** Folds contiguous changes into one: same chain of text and versions, deltas concatenated in order. */
function mergeContiguous(changes: readonly Change[]): Change[] {
  const out: Change[] = [];
  for (const next of changes) {
    const last = out[out.length - 1];
    if (last?.deltas && next.deltas && sameDraft(next.before, last.draft)) {
      out[out.length - 1] = {
        ...next,
        ...(last.before ? { before: last.before } : {}),
        deltas: [...last.deltas, ...next.deltas],
      };
    } else out.push(next);
  }
  return out;
}

export class DraftState {
  readonly #rules: TypingRules;
  #draft: Draft;
  /** The draft the next change's `before` must match: the last one the change stream accounted for. */
  #base: Draft;
  #epoch = 0;
  #holds = 0;
  #held: Change[] = [];
  #awaiting: Awaiting | null = null;
  #resyncs = 0;
  #ledgerChecks = 0;

  constructor(initial: Draft, rules: TypingRules) {
    checkDraft(initial);
    this.#rules = rules;
    // Text that was there before the session started has no provable origin.
    this.#draft = { ...initial, typedSpans: [] };
    this.#base = this.#draft;
  }

  get draft(): Draft {
    return this.#draft;
  }

  /** Raised on every key and every change the session did not cause; older results become stale. */
  get epoch(): number {
    return this.#epoch;
  }

  get resyncs(): number {
    return this.#resyncs;
  }

  /** Changes whose `before` and deltas were checked against the reported draft and added up. */
  get ledgerChecks(): number {
    return this.#ledgerChecks;
  }

  get holding(): boolean {
    return this.#holds > 0;
  }

  bumpEpoch(): void {
    this.#epoch++;
  }

  /** The adapter reported a change. Returns what to publish now: nothing while an own operation is in flight. */
  receive(raw: Change): Accepted[] {
    checkDraft(raw.draft);
    const change = degradeOrigins(raw, this.#rules.evidence);
    if (this.#holds > 0) {
      this.#held.push(change);
      return [];
    }
    return [this.#accept(change)];
  }

  /** An own commit or restore starts: hold incoming changes until its result is known. */
  hold(): void {
    this.#holds++;
  }

  /** The operation finished (after `adoptEdit`/`adoptRestore` when it applied). Returns the held changes to publish. */
  release(): Accepted[] {
    if (this.#holds === 0) throw new Error('release without hold');
    if (--this.#holds > 0) return [];
    const held = this.#held;
    this.#held = [];
    const awaiting = this.#awaiting;
    const echo = awaiting
      ? held.findIndex((c) => c.draft.version === awaiting.version && c.draft.text === awaiting.text)
      : -1;
    // The echo is published alone, so it is recognized as own; the foreign changes around it merge.
    const groups =
      echo < 0
        ? mergeContiguous(held)
        : [...mergeContiguous(held.slice(0, echo)), held[echo] as Change, ...mergeContiguous(held.slice(echo + 1))];
    return groups.map((change) => this.#accept(change));
  }

  /**
   * The session's edit applied: the snapshot the host committed becomes the
   * draft at once, not a later read (lesson 47). Its typed spans follow the
   * edit as a `plugin` delta, which adds no coverage.
   */
  adoptEdit(before: Draft, edit: Edit, pluginId: string, snapshot: Draft): void {
    checkDraft(snapshot);
    const delta: DraftDelta = { origin: 'plugin', from: edit.from, to: edit.to, insert: edit.insert, pluginId };
    const fits = applyDelta(before.text, delta) === snapshot.text;
    const spans = fits ? applyChange(before, [delta], this.#rules).typedSpans : [];
    this.#draft = { ...snapshot, typedSpans: spans };
    this.#awaiting = { version: snapshot.version, text: snapshot.text, origin: 'plugin', pluginId };
  }

  /** The session's restore applied: text, cursor, selection and typed spans are the saved ones, exactly. */
  adoptRestore(target: Draft, snapshot: Draft): void {
    checkDraft(snapshot);
    const exact = snapshot.text === target.text && validSpans(target.typedSpans, snapshot.text.length);
    this.#draft = { ...snapshot, typedSpans: exact ? target.typedSpans : [] };
    this.#awaiting = { version: snapshot.version, text: snapshot.text, origin: 'undo' };
  }

  #accept(change: Change): Accepted {
    const awaiting = this.#awaiting;
    if (awaiting && change.draft.version === awaiting.version && change.draft.text === awaiting.text) {
      return this.#acceptOwn(change, awaiting);
    }
    // A newer foreign change means the own snapshot will never echo.
    if (awaiting && change.draft.version >= awaiting.version) this.#awaiting = null;

    const deltas = change.deltas ?? [];
    // An adapter that does not echo the session's own commit continues from the adopted snapshot.
    const base = sameDraft(change.before, this.#draft) ? this.#draft : this.#base;
    let next: Draft;
    if (deltas.length === 0 && change.draft.text === base.text) {
      // Cursor, selection, certainty or host state only: the text and its spans stay.
      next = { ...change.draft, typedSpans: base.typedSpans };
    } else if (
      (change.before === undefined || sameDraft(change.before, base)) &&
      verifyLedger(base, deltas, change.draft)
    ) {
      next = { ...change.draft, typedSpans: applyChange(base, deltas, this.#rules).typedSpans };
    } else {
      return this.#resync(change, base);
    }
    this.#ledgerChecks++;
    this.#base = next;
    this.#draft = next;
    return {
      change: {
        draft: next,
        origin: change.origin,
        ...(change.pluginId === undefined ? {} : { pluginId: change.pluginId }),
        before: base,
        deltas,
      },
      own: false,
      resynced: false,
    };
  }

  #acceptOwn(change: Change, awaiting: Awaiting): Accepted {
    this.#awaiting = null;
    const base = this.#base;
    const draft = this.#draft;
    const deltas = (change.deltas ?? []).map((d) =>
      d.origin === 'plugin' && awaiting.pluginId !== undefined ? { ...d, pluginId: awaiting.pluginId } : d,
    );
    if (!verifyLedger(base, deltas, draft)) return this.#resync(change, base);
    this.#ledgerChecks++;
    this.#base = draft;
    return {
      change: {
        draft,
        origin: awaiting.origin,
        ...(awaiting.pluginId === undefined ? {} : { pluginId: awaiting.pluginId }),
        before: base,
        deltas,
      },
      own: true,
      resynced: false,
    };
  }

  #resync(change: Change, base: Draft): Accepted {
    this.#resyncs++;
    this.#awaiting = null;
    const draft: Draft = { ...change.draft, typedSpans: [] };
    this.#base = draft;
    this.#draft = draft;
    const deltas: DraftDelta[] =
      base.text === draft.text ? [] : [{ origin: 'unknown', from: 0, to: base.text.length, insert: draft.text }];
    return { change: { draft, origin: 'unknown', before: base, deltas }, own: false, resynced: true };
  }
}

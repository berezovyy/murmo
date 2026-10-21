// One native transaction: walk every typed code point (not UTF-16 unit — the
// r13 `teh.🙂` bug was `char.length === 1`, E17), apply shortcuts before typos,
// wait on `.`, rebase later native ranges. No plugin, timer or host read.

import type { Draft, DraftDelta, Range } from '@murmo/api';
import type { InlineAnswer, InlineCorrection, InlineReplay, InlineSnapshot } from '@murmo/api/adapter';
import { type Spans, splice } from '@murmo/provenance';
import { codePoints, unsafeText, utf8Length } from '@murmo/text';
import { replayNextKey } from './commit.ts';
import { lookupWord, POLICY_BOUNDARIES, type RegisteredInline } from './registry.ts';
import { cursorAfterUndo, rebaseDeferred, rebasePatches, type UndoPatch } from './undo.ts';

export interface Proposal {
  from: number;
  to: number;
  insert: string;
  original: string;
  word: boolean;
}

export interface DeferredEdit {
  from: number;
  to: number;
  insert: string;
  expected: string;
}

export interface WalkState {
  text: string;
  cursor: number;
  spans: Spans;
  undo: UndoPatch[];
  pending: (Proposal & { text: string; cursor: number }) | null;
  immediate: boolean;
}

export interface WalkResult {
  state: WalkState;
  replay: InlineReplay;
  corrections: InlineCorrection[];
  deferred: DeferredEdit[];
  rejected?: string;
}

const letterOrDigit = /^[\p{L}\p{N}]$/u;

export function emptyState(snapshot: InlineSnapshot): WalkState {
  return {
    text: snapshot.text,
    cursor: snapshot.cursor,
    spans: snapshot.typedSpans.map((r) => [r[0], r[1]] as Range),
    undo: [],
    pending: null,
    immediate: false,
  };
}

export function cloneState(state: WalkState): WalkState {
  return {
    text: state.text,
    cursor: state.cursor,
    spans: state.spans.map((r) => [r[0], r[1]] as Range),
    undo: state.undo.map((r) => ({ ...r, spans: r.spans.map((x) => [x[0], x[1]] as Range) })),
    pending: state.pending ? { ...state.pending } : null,
    immediate: state.immediate,
  };
}

function typedCovers(spans: readonly Range[], from: number, to: number): boolean {
  if (!(from < to)) return false;
  return spans.some(([a, b]) => a <= from && b >= to);
}

/** Native-chain positions → working-text positions after earlier corrections. */
function growMap(
  map: number[],
  nativeFrom: number,
  nativeTo: number,
  insertLength: number,
  workingFrom: number,
): number[] {
  const mappedTo = map[nativeTo] ?? workingFrom;
  const shift = insertLength - (mappedTo - workingFrom);
  return [
    ...map.slice(0, nativeFrom + 1),
    ...Array.from({ length: insertLength }, (_, i) => workingFrom + i + 1),
    ...map.slice(nativeTo + 1).map((p) => p + shift),
  ];
}

function mapAfterCorrection(map: number[], from: number, to: number, insertLength: number): number[] {
  const shift = insertLength - (to - from);
  return map.map((p) => (p <= from ? p : p >= to ? p + shift : from + Math.min(p - from, insertLength)));
}

export function planWalk(
  rule: RegisteredInline,
  snapshot: InlineSnapshot,
  prior: WalkState | null,
  rejected: ReadonlySet<string>,
  allowBackspace: boolean,
): WalkResult | { action: 'native' } {
  let source = snapshot;
  if (source.deferred) {
    const d = source.deferred;
    if (replayNextKey(d.before, d.deltas, d.atVersion, source) === null) return { action: 'native' };
    const { deferred: _dropped, ...rest } = source;
    source = {
      ...rest,
      text: d.before.text,
      cursor: d.before.cursor,
      typedSpans: d.before.typedSpans,
      version: d.before.version,
      deltas: [...d.deltas, ...source.deltas],
    };
  }

  const reusable = prior !== null && prior.text === source.text && prior.cursor === source.cursor;
  const w = reusable ? cloneState(prior) : emptyState(source);
  const owner = rule.owner;
  const before: Draft = {
    text: source.text,
    cursor: source.cursor,
    version: source.version,
    certainty: source.certainty ?? 'authoritative',
    typedSpans: source.typedSpans.map((r) => [r[0], r[1]] as Range),
  };
  const trace: Array<{ origin: DraftDelta['origin']; from: number; to: number; insert: string; pluginId?: string }> =
    [];
  const corrections: InlineCorrection[] = [];
  const deferred: DeferredEdit[] = [];

  const emit = (e: (typeof trace)[number]) => {
    const last = trace.at(-1);
    if (
      last &&
      last.origin === e.origin &&
      e.from === e.to &&
      last.from === last.to &&
      e.from === last.from + last.insert.length
    ) {
      last.insert += e.insert;
    } else trace.push(e);
  };

  const spliceText = (from: number, to: number, insert: string, origin: DraftDelta['origin']) => {
    rebasePatches(w.undo, from, to, insert.length);
    rebaseDeferred(deferred, from, to, insert.length);
    w.text = w.text.slice(0, from) + insert + w.text.slice(to);
    w.spans = splice(w.spans, from, to, insert.length, origin === 'typed');
    w.cursor = from + insert.length;
    emit({ origin, from, to, insert, ...(origin === 'plugin' ? { pluginId: owner } : {}) });
  };

  const finalReplay = (): InlineReplay => {
    if (!snapshot.deferred) {
      return { before, deltas: trace, typedSpans: w.spans, corrections, undoDepth: w.undo.length };
    }
    const fresh: Draft = {
      text: snapshot.text,
      cursor: snapshot.cursor,
      version: snapshot.version,
      certainty: snapshot.certainty ?? 'authoritative',
      typedSpans: snapshot.typedSpans.map((r) => [r[0], r[1]] as Range),
    };
    const deltas: DraftDelta[] = [
      ...(snapshot.deltas.length
        ? snapshot.deltas
        : [{ origin: snapshot.origin, from: snapshot.key.from, to: snapshot.key.to, insert: snapshot.key.inputText }]),
    ];
    let text = fresh.text;
    for (const e of deltas) text = text.slice(0, e.from) + e.insert + text.slice(e.to);
    let from = 0;
    let to = text.length;
    let end = w.text.length;
    while (from < to && from < end && text[from] === w.text[from]) from++;
    while (to > from && end > from && text[to - 1] === w.text[end - 1]) {
      to--;
      end--;
    }
    if (from < to || from < end)
      deltas.push({ origin: 'plugin', pluginId: owner, from, to, insert: w.text.slice(from, end) });
    return { before: fresh, deltas, typedSpans: w.spans, corrections, undoDepth: w.undo.length };
  };

  const undoKey = source.key.id === 'Undo' || source.key.id === 'F6';
  const backspace = source.key.id === 'Backspace';
  const undoPatch = w.undo.length ? w.undo[w.undo.length - 1] : undefined;
  if ((undoKey || (backspace && allowBackspace && w.immediate)) && undoPatch) {
    w.undo.pop();
    const r = undoPatch;
    if (w.text.slice(r.from, r.from + r.insert.length) !== r.insert) return { action: 'native' };
    const cursor = w.cursor;
    spliceText(r.from, r.from + r.insert.length, r.original, 'undo');
    w.cursor = cursorAfterUndo(cursor, r.from, r.insert, r.original);
    for (const [a, b] of r.spans) {
      const from = r.from + a;
      const to = r.from + b;
      // Intake recomputes spans from deltas, so the restored coverage must be a typed splice.
      spliceText(from, to, w.text.slice(from, to), 'typed');
      w.cursor = cursorAfterUndo(cursor, r.from, r.insert, r.original);
    }
    if (backspace && r.reject && w.cursor > 0 && w.text[w.cursor - 1] === ' ') {
      const at = w.cursor;
      spliceText(at - 1, at, '', 'undo');
    }
    w.pending = null;
    w.immediate = false;
    corrections.push({
      from: r.from,
      to: r.from + r.insert.length,
      insert: r.original,
      original: r.insert,
      kind: 'undo',
    });
    return { state: w, replay: finalReplay(), corrections, deferred: [], rejected: r.word };
  }

  w.immediate = false;
  const deltas = source.deltas.length
    ? source.deltas
    : [{ origin: source.origin, from: source.key.from, to: source.key.to, insert: source.key.inputText }];
  let native = source.text;
  let map: number[] | null = deltas.length > 1 ? Array.from({ length: native.length + 1 }, (_, i) => i) : null;

  for (const delta of deltas) {
    if (
      !Number.isInteger(delta.from) ||
      !Number.isInteger(delta.to) ||
      delta.from < 0 ||
      delta.to < delta.from ||
      delta.to > native.length ||
      typeof delta.insert !== 'string'
    ) {
      return { action: 'native' };
    }
    const from = map ? (map[delta.from] ?? delta.from) : delta.from;
    const to = map ? (map[delta.to] ?? delta.to) : delta.to;
    if (map) map = growMap(map, delta.from, delta.to, delta.insert.length, from);
    native = native.slice(0, delta.from) + delta.insert + native.slice(delta.to);
    if (to > from) {
      spliceText(from, to, '', delta.origin);
      w.pending = null;
      w.immediate = false;
    }
    w.cursor = from;
    if (delta.origin !== 'typed') {
      spliceText(from, from, delta.insert, delta.origin);
      w.pending = null;
      w.immediate = false;
      if (!w.text) {
        w.undo = [];
      }
      continue;
    }
    for (const step of codePoints(delta.insert)) {
      const char = String.fromCodePoint(step.codePoint);
      const at = w.cursor;
      const priorPending = w.pending;
      w.pending = null;
      w.immediate = false;
      let proposal: Proposal | null = null;
      if (priorPending && priorPending.text === w.text && priorPending.cursor === at && !letterOrDigit.test(char)) {
        proposal = priorPending;
      } else if (POLICY_BOUNDARIES.includes(char)) {
        proposal = lookupAtBoundary(rule, w, at, char, rejected);
      }
      spliceText(at, at, char, 'typed');
      if (proposal?.word && char === '.' && !priorPending) {
        w.pending = { ...proposal, text: w.text, cursor: w.cursor };
        continue;
      }
      if (!proposal || unsafeText(proposal.insert) !== null || utf8Length(proposal.insert) > rule.maxInsertBytes)
        continue;
      if (!proposal.word && utf8Length(proposal.insert) > rule.inlineMaxBytes) {
        deferred.push({ from: proposal.from, to: proposal.to, insert: proposal.insert, expected: proposal.original });
        continue;
      }
      const oldCursor = w.cursor;
      const spans: Range[] = w.spans.flatMap(([a, b]) => {
        const left = Math.max(a, proposal.from);
        const right = Math.min(b, proposal.to);
        return left < right ? [[left - proposal.from, right - proposal.from] as Range] : [];
      });
      spliceText(proposal.from, proposal.to, proposal.insert, 'plugin');
      w.cursor = oldCursor + proposal.insert.length - (proposal.to - proposal.from);
      if (map) map = mapAfterCorrection(map, proposal.from, proposal.to, proposal.insert.length);
      w.undo.push({
        from: proposal.from,
        insert: proposal.insert,
        original: proposal.original,
        spans,
        reject: proposal.word,
        word: proposal.original.toLowerCase(),
      });
      w.immediate = true;
      corrections.push({
        from: proposal.from,
        to: proposal.to,
        insert: proposal.insert,
        original: proposal.original,
        kind: proposal.word ? 'typo' : 'shortcut',
      });
    }
  }

  if (!w.text) {
    w.undo = [];
    w.pending = null;
  }
  return { state: w, replay: finalReplay(), corrections, deferred };
}

function lookupAtBoundary(
  rule: RegisteredInline,
  w: WalkState,
  at: number,
  char: string,
  rejected: ReadonlySet<string>,
): Proposal | null {
  const prefix = w.text.slice(0, at);
  const raw = /\S+$/.exec(prefix)?.[0];
  if (!raw) return null;
  if (rule.vocabulary.has(raw.toLowerCase())) return null;
  // Exact match only (phase 15): a declared `rvw` does not expand `;rvw`.
  const shortcut = rule.replacements.get(raw);
  const from = at - raw.length;
  if (char !== '.' && shortcut !== undefined && typedCovers(w.spans, from, at) && !rule.policy.inCode(prefix)) {
    return { from, to: at, insert: shortcut, original: raw, word: false };
  }
  const p = rule.policy.propose({
    text: w.text,
    cursor: at,
    typed: char,
    rejected,
    vocabulary: rule.vocabulary,
    lookup: (word) => lookupWord(rule.table, word),
  });
  if (p && typedCovers(w.spans, p.from, p.to)) {
    return { from: p.from, to: p.to, insert: p.insert, original: w.text.slice(p.from, p.to), word: true };
  }
  return null;
}

export function replaceAnswer(
  owner: string,
  ruleId: string,
  w: WalkState,
  replay: InlineReplay,
): Extract<InlineAnswer, { action: 'replace' }> {
  const last = w.undo.at(-1);
  const beforeText = last
    ? w.text.slice(0, last.from) + last.original + w.text.slice(last.from + last.insert.length)
    : w.text;
  const beforeCursor =
    last && w.cursor >= last.from + last.insert.length
      ? w.cursor + last.original.length - last.insert.length
      : w.cursor;
  return {
    action: 'replace',
    text: w.text,
    cursor: w.cursor,
    owner,
    ruleId,
    undo: { beforeText, beforeCursor, rejectSeparator: !!last?.reject },
    replay,
  };
}

// Edit fuzz: typed words with and without typos, the undo window (Backspace,
// the undo key, keys that close it), pastes and busy toggles, against a host
// that commits at once, holds every commit until the next input lands, or
// takes keys while a commit is still returning. Ported from
// experiments/platform/core/fuzz.mjs (seed 0x11c0ffee, 10,000 runs): the
// prototype checked the edit audit, every owned undo and the stale drops; the
// core subject adds a ledger check on every change and a host-side undo
// oracle, so a stream fails on any version race, inexact restore or lost delta.
//
// The oracle models the sample autocorrect the subject loads (a typo word is
// corrected when the trailing run of typed letters before a typed space is a
// known typo) and the core's rules: commits are refused while busy, a held
// commit is dropped by the next input, a racing key closes the undo window,
// Backspace restores the word without its space and the undo key with it.
// It derives every expectation from the spec alone, never from the engine.

import type { EditorCase, Step } from '../format.ts';
import { xorshift32 } from './prng.ts';
import type { Generated, Generator } from './types.ts';

/** The sample autocorrect's typo table (packages/api/examples/autocorrect). */
export const editTypos: readonly (readonly [string, string])[] = [
  ['teh', 'the'],
  ['adn', 'and'],
  ['taht', 'that'],
  ['recieve', 'receive'],
  ['becuase', 'because'],
  ['seperate', 'separate'],
];

const plainWords = ['ok', 'ship', 'hello', 'a'];
const pastes = ['teh ', 'x', 'adn', ' tail '];

export type EditsTiming = 'immediate' | 'hold' | 'race';

export type EditsOp =
  /** A word typed key by key, then a typed space. */
  | { kind: 'word'; word: string }
  | { kind: 'paste'; text: string }
  /** Backspace or the undo key (F6): Murmo's undo while its window is open, else the host's key. */
  | { kind: 'undo'; key: 'Backspace' | 'F6' }
  | { kind: 'busy'; on: boolean };

export interface EditsSpec {
  timing: EditsTiming;
  /** `observed-unmarked`: nothing counts as typed, so nothing is corrected (round 14 rerun). */
  evidence: 'host-labeled' | 'observed-unmarked';
  ops: EditsOp[];
}

interface Unit {
  ch: string;
  typed: boolean;
}

interface Model {
  units: Unit[];
  busy: boolean;
  /** The draft before the last correction, while the undo window is open. */
  armed: Unit[] | null;
  corrections: number;
  restores: number;
}

const typos = new Map(editTypos);
const isLetter = (ch: string) => /^[A-Za-z]$/.test(ch);
const textOf = (units: readonly Unit[]) => units.map((u) => u.ch).join('');

function spansOf(units: readonly Unit[]): [number, number][] {
  const spans: [number, number][] = [];
  units.forEach((u, i) => {
    if (!u.typed) return;
    const last = spans.at(-1);
    if (last && last[1] === i) last[1] = i + 1;
    else spans.push([i, i + 1]);
  });
  return spans;
}

/**
 * After a typed change: the correction the sample would propose, if any. The
 * typed-only view masks untyped text, so the word is the trailing run of
 * typed letters before a typed final space.
 */
function proposal(units: readonly Unit[]): { from: number; fix: string } | null {
  const end = units.length;
  if (end < 2 || units[end - 1]?.ch !== ' ' || !units[end - 1]?.typed) return null;
  let from = end - 1;
  while (from > 0 && units[from - 1]?.typed && isLetter(units[from - 1]?.ch ?? '')) from--;
  const fix = typos.get(textOf(units.slice(from, end - 1)));
  return fix === undefined || from === end - 1 ? null : { from, fix };
}

/** A typed-origin change happened (a key's insert or the host's Backspace). */
function afterTyped(m: Model, spec: EditsSpec): void {
  const p = proposal(m.units);
  if (!p || m.busy || spec.timing === 'hold') return;
  const before = m.units.map((u) => ({ ...u }));
  m.units = [...m.units.slice(0, p.from), ...[...`${p.fix} `].map((ch) => ({ ch, typed: false }))];
  m.corrections++;
  if (spec.timing === 'race') {
    // The racing key lands before the commit returns: the window never opens.
    m.units.push({ ch: ' ', typed: true });
    m.armed = null;
  } else m.armed = before;
}

function key(m: Model, spec: EditsSpec, ch: string): void {
  m.armed = null;
  m.units.push({ ch, typed: spec.evidence === 'host-labeled' });
  afterTyped(m, spec);
}

function undo(m: Model, spec: EditsSpec, which: 'Backspace' | 'F6'): boolean {
  const armed = m.armed;
  m.armed = null;
  if (armed && !m.busy) {
    m.units = which === 'Backspace' && armed.at(-1)?.ch === ' ' ? armed.slice(0, -1) : armed;
    m.restores++;
    return true;
  }
  if (which === 'Backspace' && m.units.length) {
    m.units = m.units.slice(0, -1);
    afterTyped(m, spec);
  }
  return false;
}

function* generate(seed: number, size: number): Iterable<Generated<EditsSpec, EditorCase>> {
  const random = xorshift32(seed);
  for (let index = 0; index < size; index++) {
    const r = random.next();
    const timing: EditsTiming = r < 0.5 ? 'immediate' : r < 0.75 ? 'hold' : 'race';
    const evidence = random.next() < 0.1 ? 'observed-unmarked' : 'host-labeled';
    const ops: EditsOp[] = [];
    let busy = false;
    const length = 3 + random.int(8);
    for (let n = 0; n < length; n++) {
      const kind = random.next();
      if (kind < 0.55) {
        const typo = random.next() < 0.6;
        ops.push({ kind: 'word', word: typo ? random.pick(editTypos)[0] : random.pick(plainWords) });
        // Half the typos are undone at once, so most streams exercise the owned undo (the prototype forced one per run).
        if (typo && random.next() < 0.5) ops.push({ kind: 'undo', key: random.next() < 0.5 ? 'Backspace' : 'F6' });
      } else if (kind < 0.8) ops.push({ kind: 'undo', key: random.next() < 0.5 ? 'Backspace' : 'F6' });
      else if (kind < 0.9) ops.push({ kind: 'paste', text: random.pick(pastes) });
      else {
        busy = !busy;
        ops.push({ kind: 'busy', on: busy });
      }
    }
    const spec: EditsSpec = { timing, evidence, ops };
    yield { index, spec, case: build(spec, `edits-${seed}-${index}`), counts: count(spec) };
  }
}

function simulate(spec: EditsSpec, onUndo?: (m: Model, restored: boolean) => void): Model {
  const m: Model = { units: [], busy: false, armed: null, corrections: 0, restores: 0 };
  for (const op of spec.ops) {
    if (op.kind === 'word') for (const ch of `${op.word} `) key(m, spec, ch);
    else if (op.kind === 'paste') {
      m.armed = null;
      m.units.push(...[...op.text].map((ch) => ({ ch, typed: false })));
    } else if (op.kind === 'busy') m.busy = op.on;
    else onUndo?.(m, undo(m, spec, op.key));
  }
  return m;
}

function build(spec: EditsSpec, id: string): EditorCase {
  const steps: Step[] = [];
  const model: Model = { units: [], busy: false, armed: null, corrections: 0, restores: 0 };
  for (const op of spec.ops) {
    if (op.kind === 'word') {
      steps.push({ type: `${op.word} ` });
      for (const ch of `${op.word} `) key(model, spec, ch);
    } else if (op.kind === 'paste') {
      steps.push({ paste: op.text });
      model.armed = null;
      model.units.push(...[...op.text].map((ch) => ({ ch, typed: false })));
    } else if (op.kind === 'busy') {
      steps.push({ state: { busy: op.on } });
      model.busy = op.on;
    } else {
      const restored = undo(model, spec, op.key);
      const text = textOf(model.units);
      steps.push(
        { key: op.key, routing: restored ? 'consume' : 'pass' },
        { check: { draft: { text, cursor: text.length, typedSpans: spansOf(model.units) } } },
      );
    }
  }
  const text = textOf(model.units);
  return {
    id,
    host: {
      ...(spec.timing === 'immediate' ? {} : { commitTiming: spec.timing }),
      ...(spec.evidence === 'host-labeled' ? {} : { inputOriginEvidence: spec.evidence }),
    },
    steps,
    expect: {
      draft: { text, cursor: text.length, typedSpans: spansOf(model.units) },
      stats: { corrections: model.corrections, restores: model.restores, restoreMismatches: 0, resyncs: 0 },
    },
  };
}

function count(spec: EditsSpec): Record<string, number> {
  let undoChecks = 0;
  let hostUndoKeys = 0;
  const m = simulate(spec, (_, restored) => {
    if (restored) undoChecks++;
    else hostUndoKeys++;
  });
  const words = spec.ops.filter((o) => o.kind === 'word');
  return {
    runs: 1,
    keys: words.reduce((n, o) => n + o.word.length + 1, 0) + undoChecks + hostUndoKeys,
    corrections: m.corrections,
    undoChecks,
    hostUndoKeys,
    pastes: spec.ops.filter((o) => o.kind === 'paste').length,
    busyToggles: spec.ops.filter((o) => o.kind === 'busy').length,
    heldStreams: spec.timing === 'hold' ? 1 : 0,
    racedStreams: spec.timing === 'race' ? 1 : 0,
    degradedStreams: spec.evidence === 'host-labeled' ? 0 : 1,
  };
}

/** Shorter specs: drop one op at a time. */
function* shrink(spec: EditsSpec): Iterable<EditsSpec> {
  for (let i = spec.ops.length - 1; i >= 0; i--) {
    yield { ...spec, ops: [...spec.ops.slice(0, i), ...spec.ops.slice(i + 1)] };
  }
  if (spec.timing !== 'immediate') yield { ...spec, timing: 'immediate' };
  if (spec.evidence !== 'host-labeled') yield { ...spec, evidence: 'host-labeled' };
}

export const edits: Generator<EditsSpec, EditorCase> = { name: 'edits', generate, build, count, shrink };

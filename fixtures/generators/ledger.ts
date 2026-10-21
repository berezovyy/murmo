// Random change ledgers for @murmo/provenance (docs/plan/04 § Fixtures): typed
// key bursts, multi-character typed commits, pastes, IME commits, typed text
// with a paste in the middle of one change, Backspace, plugin replacements,
// fills and history recalls, cursor moves, selections replaced by the next
// edit, and undo restores of an earlier state. Every change is one ordered
// delta list plus the text the host reports after it; `verifyLedger` must hold
// for each (r13 checked 68,936 per cohort, lesson 63).
//
// The oracle models the draft as code points with a typed flag each and
// derives cursors, typed spans and the typed-only view from that alone. A code
// point is typed only when it came from a `typed` delta under host-labeled
// evidence, one key at a time unless the adapter declares key bursts (lessons
// 52, 64, 80). It never calls the code under test.

import type { PureCase } from '../format.ts';
import { xorshift32 } from './prng.ts';
import type { Generated, Generator } from './types.ts';

/** Whole graphemes, split into code points when inserted. */
export const ledgerAlphabet: readonly string[] = [
  'a',
  'e',
  't',
  'h',
  ' ',
  '.',
  '\n',
  'é',
  'e\u{301}',
  '\u{1F600}',
  '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}',
  '\u{1F1FA}\u{1F1E6}',
  '字',
  '\u{3000}',
  'sk_',
];

export type Evidence = 'host-labeled' | 'observed-unmarked' | 'unknown';

export type LedgerOp =
  /** Typed key by key at the cursor: one `typed` delta per code point, all in one change. */
  | { op: 'keys'; text: number[] }
  /** One `typed` delta with several code points: a key burst only if the adapter says so. */
  | { op: 'chunk'; text: number[] }
  | { op: 'paste' | 'ime'; text: number[] }
  /** Typed keys, a paste, typed keys: one change, ordered deltas with two origins. */
  | { op: 'mixed'; before: number[]; paste: number[]; after: number[] }
  /** Typed Backspace, one delta per deleted code point (the selection first, if any). */
  | { op: 'backspace'; count: number }
  /** A plugin replaces code points `[from, to)`. */
  | { op: 'plugin'; from: number; to: number; text: number[] }
  /** The whole draft replaced: a programmatic fill (`unknown`) or a history recall. */
  | { op: 'replace'; origin: 'unknown' | 'history'; text: number[] }
  | { op: 'move'; at: number }
  /** Code points `[from, to)`; the next edit replaces them. */
  | { op: 'select'; from: number; to: number }
  /** Restore the state after change `to` exactly (-1: the empty start). */
  | { op: 'undo'; to: number };

export interface LedgerSpec {
  evidence: Evidence;
  keyBursts: boolean;
  ops: LedgerOp[];
}

interface Delta {
  origin: string;
  from: number;
  to: number;
  insert: string;
  pluginId?: string;
}

type Change = { deltas: Delta[]; after: string } | { move: number } | { select: [number, number] } | { undo: number };

interface Atom {
  text: string;
  typed: boolean;
}

interface Model {
  atoms: Atom[];
  cursor: number;
  selection: [number, number] | null;
}

const MASK = '█';

const codePointsOf = (ids: readonly number[]): string[] => Array.from(ids.map((i) => ledgerAlphabet[i] ?? '').join(''));
const textOf = (atoms: readonly Atom[]): string => atoms.map((a) => a.text).join('');
function unitsBefore(atoms: readonly Atom[], index: number): number {
  let units = 0;
  for (let i = 0; i < index; i++) units += (atoms[i] as Atom).text.length;
  return units;
}
const copy = (m: Model): Model => ({
  atoms: m.atoms.map((a) => ({ ...a })),
  cursor: m.cursor,
  selection: m.selection ? [m.selection[0], m.selection[1]] : null,
});

/** The cursor rule: before the range it stays, after it shifts, on or inside it lands after the insert. */
function mapCursor(cursor: number, from: number, to: number, inserted: number): number {
  return cursor < from ? cursor : cursor > to ? cursor + inserted - (to - from) : from + inserted;
}

/** Replaces atoms `[from, to)` and records the delta in UTF-16 units of the text before it. */
function splice(model: Model, deltas: Delta[], from: number, to: number, added: Atom[], origin: string): void {
  deltas.push({
    origin,
    from: unitsBefore(model.atoms, from),
    to: unitsBefore(model.atoms, to),
    insert: textOf(added),
    ...(origin === 'plugin' ? { pluginId: 'fixture' } : {}),
  });
  model.atoms.splice(from, to - from, ...added);
  model.cursor = mapCursor(model.cursor, from, to, added.length);
  model.selection = null;
}

/** Inserts at the cursor, replacing the selection if there is one. */
function insertAtCursor(model: Model, deltas: Delta[], added: Atom[], origin: string): void {
  const [from, to] = model.selection ?? [model.cursor, model.cursor];
  splice(model, deltas, from, to, added, origin);
}

function apply(spec: LedgerSpec, model: Model, op: LedgerOp, saved: readonly Model[]): Change {
  const host = spec.evidence === 'host-labeled';
  const deltas: Delta[] = [];
  const typedKeys = (ids: readonly number[]) => {
    for (const cp of codePointsOf(ids)) insertAtCursor(model, deltas, [{ text: cp, typed: host }], 'typed');
  };
  switch (op.op) {
    case 'keys':
      typedKeys(op.text);
      break;
    case 'chunk': {
      const cps = codePointsOf(op.text);
      const typed = host && (spec.keyBursts || cps.length === 1);
      insertAtCursor(
        model,
        deltas,
        cps.map((text) => ({ text, typed })),
        'typed',
      );
      break;
    }
    case 'paste':
    case 'ime':
      insertAtCursor(
        model,
        deltas,
        codePointsOf(op.text).map((text) => ({ text, typed: false })),
        op.op,
      );
      break;
    case 'mixed':
      typedKeys(op.before);
      insertAtCursor(
        model,
        deltas,
        codePointsOf(op.paste).map((text) => ({ text, typed: false })),
        'paste',
      );
      typedKeys(op.after);
      break;
    case 'backspace':
      for (let n = 0; n < op.count; n++) {
        if (model.selection) splice(model, deltas, model.selection[0], model.selection[1], [], 'typed');
        else if (model.cursor > 0) splice(model, deltas, model.cursor - 1, model.cursor, [], 'typed');
      }
      break;
    case 'plugin':
      splice(
        model,
        deltas,
        op.from,
        op.to,
        codePointsOf(op.text).map((text) => ({ text, typed: false })),
        'plugin',
      );
      break;
    case 'replace':
      splice(
        model,
        deltas,
        0,
        model.atoms.length,
        codePointsOf(op.text).map((text) => ({ text, typed: false })),
        op.origin,
      );
      break;
    case 'move':
      model.cursor = op.at;
      model.selection = null;
      return { move: unitsBefore(model.atoms, op.at) };
    case 'select':
      model.selection = [op.from, op.to];
      model.cursor = op.to;
      return { select: [unitsBefore(model.atoms, op.from), unitsBefore(model.atoms, op.to)] };
    case 'undo': {
      const state = saved[op.to + 1];
      if (!state) throw new RangeError(`undo to ${op.to}: no such state`);
      const restored = copy(state);
      model.atoms = restored.atoms;
      model.cursor = restored.cursor;
      model.selection = restored.selection;
      return { undo: op.to };
    }
  }
  return { deltas, after: textOf(model.atoms) };
}

function spansOf(atoms: readonly Atom[]): [number, number][] {
  const out: [number, number][] = [];
  let at = 0;
  for (const a of atoms) {
    const end = at + a.text.length;
    if (a.typed) {
      const last = out[out.length - 1];
      if (last && last[1] === at) last[1] = end;
      else out.push([at, end]);
    }
    at = end;
  }
  return out;
}

interface Simulation {
  changes: Change[];
  /** `models[i + 1]` is the state after op `i`; `models[0]` the empty start. */
  models: Model[];
}

function simulate(spec: LedgerSpec): Simulation {
  const model: Model = { atoms: [], cursor: 0, selection: null };
  const run: Simulation = { changes: [], models: [copy(model)] };
  for (const op of spec.ops) {
    run.changes.push(apply(spec, model, op, run.models));
    run.models.push(copy(model));
  }
  return run;
}

function caseOf(spec: LedgerSpec, { changes, models }: Simulation, id: string): PureCase {
  const final = models[models.length - 1] as Model;
  const ledgers = changes.filter((c) => 'deltas' in c).length;
  return {
    id,
    input: { evidence: spec.evidence, keyBursts: spec.keyBursts, changes },
    output: {
      steps: models.slice(1).map((m) => [unitsBefore(m.atoms, m.cursor), spansOf(m.atoms)]),
      text: textOf(final.atoms),
      selection: final.selection
        ? [unitsBefore(final.atoms, final.selection[0]), unitsBefore(final.atoms, final.selection[1])]
        : null,
      projected: final.atoms.map((a) => (a.typed ? a.text : MASK.repeat(a.text.length))).join(''),
      verified: ledgers,
      coalesced: ledgers,
    },
  };
}

function countsOf(spec: LedgerSpec, { changes }: Simulation): Record<string, number> {
  const counts: Record<string, number> = { sequences: 1, changes: changes.length, ledgers: 0, deltas: 0 };
  for (const c of changes) {
    if (!('deltas' in c)) continue;
    counts.ledgers = (counts.ledgers ?? 0) + 1;
    counts.deltas = (counts.deltas ?? 0) + c.deltas.length;
  }
  for (const op of spec.ops) counts[op.op] = (counts[op.op] ?? 0) + 1;
  return counts;
}

const build = (spec: LedgerSpec, id: string): PureCase => caseOf(spec, simulate(spec), id);
const count = (spec: LedgerSpec): Record<string, number> => countsOf(spec, simulate(spec));

const opKinds = [
  'keys',
  'keys',
  'keys',
  'chunk',
  'paste',
  'ime',
  'mixed',
  'backspace',
  'plugin',
  'replace',
  'move',
  'select',
  'undo',
] as const;

/** Ops that must not follow a selection: the edit after a selection replaces it. */
const editsSelection = new Set(['keys', 'chunk', 'paste', 'ime', 'mixed', 'backspace']);

function* generate(seed: number, size: number): Iterable<Generated<LedgerSpec, PureCase>> {
  const random = xorshift32(seed);
  const text = (max: number): number[] =>
    Array.from({ length: 1 + random.int(max) }, () => random.int(ledgerAlphabet.length));
  for (let index = 0; index < size; index++) {
    const roll = random.int(10);
    const spec: LedgerSpec = {
      evidence: roll < 8 ? 'host-labeled' : roll === 8 ? 'observed-unmarked' : 'unknown',
      keyBursts: random.int(2) === 1,
      ops: [],
    };
    const model: Model = { atoms: [], cursor: 0, selection: null };
    const run: Simulation = { changes: [], models: [copy(model)] };
    const { models } = run;
    const step = (op: LedgerOp) => {
      spec.ops.push(op);
      run.changes.push(apply(spec, model, op, models));
      models.push(copy(model));
    };
    for (let n = 0, limit = 1 + random.int(10); n < limit; n++) {
      const length = model.atoms.length;
      let kind: (typeof opKinds)[number] = random.pick(opKinds);
      if (model.selection && !editsSelection.has(kind)) kind = 'keys';
      let op: LedgerOp;
      if (kind === 'keys' || kind === 'chunk') op = { op: kind, text: text(6) };
      else if (kind === 'paste' || kind === 'ime') op = { op: kind, text: text(8) };
      else if (kind === 'mixed') op = { op: 'mixed', before: text(3), paste: text(4), after: text(3) };
      else if (kind === 'backspace') op = { op: 'backspace', count: 1 + random.int(3) };
      else if (kind === 'plugin') {
        const from = random.int(length + 1);
        op = { op: 'plugin', from, to: from + random.int(length - from + 1), text: text(4) };
      } else if (kind === 'replace') op = { op: 'replace', origin: random.pick(['unknown', 'history']), text: text(8) };
      else if (kind === 'move') op = { op: 'move', at: random.int(length + 1) };
      else if (kind === 'select' && length > 0) {
        const from = random.int(length);
        op = { op: 'select', from, to: from + 1 + random.int(length - from) };
      } else if (kind === 'undo') {
        // Never back to a state with a selection: the next op would have to replace it.
        const targets = models.flatMap((m, i) => (m.selection ? [] : [i - 1]));
        op = { op: 'undo', to: random.pick(targets) };
      } else op = { op: 'keys', text: text(6) };
      step(op);
    }
    if (model.selection) step({ op: 'backspace', count: 1 });
    yield { index, spec, case: caseOf(spec, run, `ledger-${seed}-${index}`), counts: countsOf(spec, run) };
  }
}

/** Valid when every position fits the draft it addresses and no selection is left for a non-edit. */
function valid(spec: LedgerSpec): boolean {
  const model: Model = { atoms: [], cursor: 0, selection: null };
  const models: Model[] = [copy(model)];
  for (const [i, op] of spec.ops.entries()) {
    const length = model.atoms.length;
    if (model.selection && !editsSelection.has(op.op)) return false;
    if (op.op === 'move' && op.at > length) return false;
    if (op.op === 'select' && (op.to > length || op.from >= op.to)) return false;
    if (op.op === 'plugin' && (op.to > length || op.from > op.to)) return false;
    if (op.op === 'undo' && (op.to >= i || models[op.to + 1]?.selection)) return false;
    apply(spec, model, op, models);
    models.push(copy(model));
  }
  return model.selection === null;
}

function* shrink(spec: LedgerSpec): Iterable<LedgerSpec> {
  for (let i = 0; i < spec.ops.length; i++) {
    const smaller = { ...spec, ops: spec.ops.filter((_, j) => j !== i) };
    if (valid(smaller)) yield smaller;
  }
  for (let i = 0; i < spec.ops.length; i++) {
    const op = spec.ops[i];
    if (!op || !('text' in op) || op.text.length < 2) continue;
    const shorter = { ...op, text: op.text.slice(0, 1) };
    const smaller = { ...spec, ops: spec.ops.map((o, j) => (j === i ? shorter : o)) };
    if (valid(smaller)) yield smaller;
  }
}

export const ledger: Generator<LedgerSpec, PureCase> = { name: 'ledger', generate, build, count, shrink };

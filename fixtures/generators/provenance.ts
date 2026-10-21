// Random editor-operation sequences for typed-span provenance and change
// ledgers: typing, pastes, IME commits, programmatic fills, history recalls,
// cursor moves, selections and Backspace, mixed in one draft. Each operation
// is followed by a checkpoint with the draft, the cursor and the typed spans
// the oracle expects; the subject must also verify every change ledger
// (r13 checked 68,936 per cohort; docs/plan/04 § Fixtures).
//
// The oracle tracks a typed flag per grapheme and nothing else: only typed
// input adds coverage, whatever the text (lesson 52); paste, IME, fill and
// history never do; a cursor move keeps it; deleting removes it.

import type { EditorCase, Origin, Step } from '../format.ts';
import { xorshift32 } from './prng.ts';
import type { Generated, Generator } from './types.ts';

/** Whole graphemes, so cursors and selections never split a character. */
export const provenanceGraphemes: readonly string[] = [
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
];

export type ProvenanceOp =
  | { op: 'type' | 'paste' | 'ime'; graphemes: number[] }
  | { op: 'fill'; origin: 'fill' | 'unknown' | 'paste'; graphemes: number[] }
  | { op: 'history'; graphemes: number[] }
  /** Cursor to a grapheme boundary, by grapheme index. */
  | { op: 'move'; at: number }
  /** Grapheme range [from, to). The next edit replaces it. */
  | { op: 'select'; from: number; to: number }
  | { op: 'backspace' };

export interface ProvenanceSpec {
  ops: ProvenanceOp[];
}

interface Atom {
  text: string;
  typed: boolean;
}

interface Model {
  atoms: Atom[];
  cursor: number;
  selection: [number, number] | null;
}

const glyph = (i: number): string => provenanceGraphemes[i] ?? '';
const textOf = (ids: readonly number[]): string => ids.map(glyph).join('');
const unitsBefore = (atoms: readonly Atom[], index: number): number =>
  atoms.slice(0, index).reduce((n, a) => n + a.text.length, 0);

function insert(model: Model, ids: readonly number[], typed: boolean): void {
  const [from, to] = model.selection ?? [model.cursor, model.cursor];
  const added = ids.map((i) => ({ text: glyph(i), typed }));
  model.atoms.splice(from, to - from, ...added);
  model.cursor = from + added.length;
  model.selection = null;
}

function replaceAll(model: Model, ids: readonly number[]): void {
  model.atoms = ids.map((i) => ({ text: glyph(i), typed: false }));
  model.cursor = model.atoms.length;
  model.selection = null;
}

function apply(model: Model, op: ProvenanceOp): void {
  switch (op.op) {
    case 'type':
      insert(model, op.graphemes, true);
      return;
    case 'paste':
    case 'ime':
      insert(model, op.graphemes, false);
      return;
    case 'fill':
    case 'history':
      replaceAll(model, op.graphemes);
      return;
    case 'move':
      model.cursor = op.at;
      model.selection = null;
      return;
    case 'select':
      model.selection = [op.from, op.to];
      model.cursor = op.to;
      return;
    case 'backspace':
      if (model.selection) {
        const [from, to] = model.selection;
        model.atoms.splice(from, to - from);
        model.cursor = from;
        model.selection = null;
      } else if (model.cursor > 0) {
        model.atoms.splice(model.cursor - 1, 1);
        model.cursor--;
      }
      return;
  }
}

function spans(atoms: readonly Atom[]): [number, number][] {
  const out: [number, number][] = [];
  let at = 0;
  for (const a of atoms) {
    const end = at + a.text.length;
    if (a.typed) {
      const last = out.at(-1);
      if (last && last[1] === at) last[1] = end;
      else out.push([at, end]);
    }
    at = end;
  }
  return out;
}

function stepOf(op: ProvenanceOp, model: Model): Step {
  switch (op.op) {
    case 'type':
      return { type: textOf(op.graphemes) };
    case 'paste':
      return { paste: textOf(op.graphemes) };
    case 'ime':
      return { ime: textOf(op.graphemes) };
    case 'fill':
      return { fill: textOf(op.graphemes), origin: op.origin satisfies Origin };
    case 'history':
      return { history: textOf(op.graphemes) };
    case 'move':
      return { move: unitsBefore(model.atoms, op.at) };
    case 'select':
      return { select: [unitsBefore(model.atoms, op.from), unitsBefore(model.atoms, op.to)] };
    case 'backspace':
      return { key: 'Backspace' };
  }
}

function build(spec: ProvenanceSpec, id: string): EditorCase {
  const model: Model = { atoms: [], cursor: 0, selection: null };
  const steps: Step[] = [{ fill: '', origin: 'unknown' }];
  // Changes that must each arrive as a lossless ledger: the first fill, every
  // typed code point, every paste, IME commit, fill and recall, every deletion.
  let changes = 1;
  for (const op of spec.ops) {
    // Unit offsets come from the draft before the operation.
    steps.push(stepOf(op, model));
    const before = model.atoms.length;
    const deleting = op.op === 'backspace' && (model.selection !== null || model.cursor > 0);
    apply(model, op);
    if (op.op === 'type') changes += Array.from(textOf(op.graphemes)).length;
    else if (op.op === 'paste' || op.op === 'ime' || op.op === 'fill' || op.op === 'history') changes++;
    else if (deleting && model.atoms.length < before) changes++;
    const text = model.atoms.map((a) => a.text).join('');
    const cursor = unitsBefore(model.atoms, model.cursor);
    steps.push({ check: { draft: { text, cursor, typedSpans: spans(model.atoms) } } });
  }
  const text = model.atoms.map((a) => a.text).join('');
  return {
    id,
    steps,
    expect: {
      draft: { text, cursor: unitsBefore(model.atoms, model.cursor), typedSpans: spans(model.atoms) },
      stats: { ledgerChecks: { min: changes } },
    },
  };
}

const opKinds = ['type', 'type', 'type', 'paste', 'ime', 'fill', 'history', 'move', 'select', 'backspace'] as const;

function* generate(seed: number, size: number): Iterable<Generated<ProvenanceSpec, EditorCase>> {
  const random = xorshift32(seed);
  const graphemes = (max: number): number[] =>
    Array.from({ length: 1 + random.int(max) }, () => random.int(provenanceGraphemes.length));
  for (let index = 0; index < size; index++) {
    const model: Model = { atoms: [], cursor: 0, selection: null };
    const ops: ProvenanceOp[] = [];
    for (let n = 0, limit = 1 + random.int(12); n < limit; n++) {
      const kind = random.pick(opKinds);
      const length = model.atoms.length;
      let op: ProvenanceOp;
      if (kind === 'type') op = { op: 'type', graphemes: graphemes(6) };
      else if (kind === 'paste' || kind === 'ime') op = { op: kind, graphemes: graphemes(8) };
      else if (kind === 'fill')
        op = { op: 'fill', origin: random.pick(['fill', 'unknown', 'paste']), graphemes: graphemes(10) };
      else if (kind === 'history') op = { op: 'history', graphemes: graphemes(10) };
      else if (kind === 'move') op = { op: 'move', at: random.int(length + 1) };
      else if (kind === 'select' && length > 0) {
        const from = random.int(length);
        op = { op: 'select', from, to: from + 1 + random.int(length - from) };
      } else op = { op: 'backspace' };
      // A selection is always followed by the edit that replaces or deletes it.
      if (model.selection && (op.op === 'move' || op.op === 'select')) op = { op: 'backspace' };
      ops.push(op);
      apply(model, op);
    }
    if (model.selection) ops.push({ op: 'backspace' });
    const spec: ProvenanceSpec = { ops };
    yield { index, spec, case: build(spec, `provenance-${seed}-${index}`), counts: count(spec) };
  }
}

function count(spec: ProvenanceSpec): Record<string, number> {
  const counts: Record<string, number> = { sequences: 1, operations: spec.ops.length };
  for (const op of spec.ops) counts[op.op] = (counts[op.op] ?? 0) + 1;
  return counts;
}

/** Valid only if every move, selection and Backspace still fits the shorter draft. */
function valid(spec: ProvenanceSpec): boolean {
  const model: Model = { atoms: [], cursor: 0, selection: null };
  for (const op of spec.ops) {
    const length = model.atoms.length;
    if (op.op === 'move' && op.at > length) return false;
    if (op.op === 'select' && (op.to > length || op.from >= op.to || model.selection)) return false;
    if (op.op === 'move' && model.selection) return false;
    apply(model, op);
  }
  return model.selection === null;
}

function* shrink(spec: ProvenanceSpec): Iterable<ProvenanceSpec> {
  for (let i = 0; i < spec.ops.length; i++) {
    const smaller = { ops: spec.ops.filter((_, j) => j !== i) };
    if (valid(smaller)) yield smaller;
  }
  for (let i = 0; i < spec.ops.length; i++) {
    const op = spec.ops[i];
    if (!op || !('graphemes' in op) || op.graphemes.length < 2) continue;
    const shorter = { ...op, graphemes: op.graphemes.slice(0, 1) };
    const smaller = { ops: spec.ops.map((o, j) => (j === i ? shorter : o)) };
    if (valid(smaller)) yield smaller;
  }
}

export const provenance: Generator<ProvenanceSpec, EditorCase> = { name: 'provenance', generate, build, count, shrink };

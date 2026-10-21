// Burst fuzz: fast typing, pastes, IME commits and history recalls delivered
// either as one native transaction (coalesced) or in chunks of 1–5 units, then
// every surviving correction undone. Ported from
// experiments/platform/devkit/regression/burst-fuzz.mjs (identical to
// core/r13/burst-fuzz.mjs). With seed 1306637 and 10,000 streams it reproduces
// the r13 and r14 per-cohort counts: 189,268 input units, 12,489 corrections,
// 9,658 undo checks, 68,936 lossless ledgers (docs/plan/02 E8).
//
// The oracle knows only the reviewed word pairs and each part's origin tag: a
// typed word is corrected exactly once, anything else stays as delivered, and
// a history recall replaces everything before it. It never calls the engine.

import type { BurstDelta, EditorCase, Origin, Step } from '../format.ts';
import { xorshift32 } from './prng.ts';
import type { Generated, Generator } from './types.ts';

/** Reviewed typo → fix pairs. Each raw word is followed by a typed space. */
export const reviewedPairs: readonly (readonly [string, string])[] = [
  ['teh', 'the'],
  ['adn', 'and'],
  ['recieve', 'receive'],
  ['adress', 'address'],
  ['i', 'I'],
];

/** Typed twice as often as each other origin, as in the prototype. */
const origins: readonly Origin[] = ['typed', 'typed', 'paste', 'ime', 'unknown', 'history'];

/** Pre-filled text in 30% of streams: programmatic, so never corrected. */
const filledBase = 'teh ';

export interface BurstPart {
  /** The raw word, without its trailing space. */
  word: string;
  fixed: string;
  origin: Origin;
  /** Chunk sizes for chunked delivery of a non-history part; they sum to the raw length. */
  chunks?: number[];
}

export interface BurstSpec {
  base: boolean;
  parts: BurstPart[];
  delivery: 'coalesced' | 'chunked';
}

interface Token {
  raw: string;
  text: string;
  origin: Origin;
  corrected: boolean;
}

const raw = (p: BurstPart): string => `${p.word} `;

function* generate(seed: number, size: number): Iterable<Generated<BurstSpec, EditorCase>> {
  const random = xorshift32(seed);
  for (let index = 0; index < size; index++) {
    const base = random.next() < 0.3;
    const parts: BurstPart[] = [];
    // The prototype re-draws the part count before every part (its loop
    // condition calls rand); kept, because it defines the seed's stream.
    for (let n = 0; n < 2 + Math.floor(random.next() * 6); n++) {
      const [word, fixed] = random.pick(reviewedPairs);
      parts.push({ word, fixed, origin: random.pick(origins) });
    }
    const delivery = random.next() < 0.5 ? 'coalesced' : 'chunked';
    if (delivery === 'chunked') {
      for (const part of parts) {
        if (part.origin === 'history') continue;
        const length = raw(part).length;
        const chunks: number[] = [];
        for (let at = 0; at < length; ) {
          const chunk = 1 + Math.floor(random.next() * Math.min(5, length - at));
          chunks.push(chunk);
          at += chunk;
        }
        part.chunks = chunks;
      }
    }
    const spec: BurstSpec = { base, parts, delivery };
    yield { index, spec, case: build(spec, `burst-${seed}-${index}`), counts: count(spec) };
  }
}

/** The tokens left in the draft: a history recall replaces everything before it. */
function survivingTokens(spec: BurstSpec): Token[] {
  const tokens: Token[] = spec.base ? [{ raw: filledBase, text: filledBase, origin: 'unknown', corrected: false }] : [];
  for (const p of spec.parts) {
    if (p.origin === 'history') tokens.length = 0;
    const typed = p.origin === 'typed';
    tokens.push({ raw: raw(p), text: `${typed ? p.fixed : p.word} `, origin: p.origin, corrected: typed });
  }
  return tokens;
}

const joined = (tokens: readonly Token[]): string => tokens.map((t) => t.text).join('');

/** Typed spans: a corrected word keeps only its typed separator; an undone word is typed again. */
function typedSpans(tokens: readonly Token[]): [number, number][] {
  const spans: [number, number][] = [];
  let at = 0;
  for (const t of tokens) {
    if (t.origin === 'typed') {
      const from = t.corrected ? at + t.text.length - 1 : at;
      const end = at + t.text.length;
      const last = spans.at(-1);
      if (last && last[1] === from) last[1] = end;
      else spans.push([from, end]);
    }
    at += t.text.length;
  }
  return spans;
}

function deliverySteps(spec: BurstSpec): Step[] {
  if (spec.delivery === 'coalesced') {
    // Deltas address the raw text the previous deltas produced: corrections
    // only happen once the whole transaction has been delivered.
    const deltas: BurstDelta[] = [];
    let pos = spec.base ? filledBase.length : 0;
    for (const p of spec.parts) {
      const history = p.origin === 'history';
      deltas.push({ origin: p.origin, text: raw(p), from: history ? 0 : pos, to: pos });
      pos = history ? raw(p).length : pos + raw(p).length;
    }
    return [{ burst: deltas }];
  }
  // Chunked: each chunk lands at the cursor after the previous chunk was
  // corrected; a history recall replaces the corrected text so far.
  const steps: Step[] = [];
  let length = spec.base ? filledBase.length : 0;
  for (const p of spec.parts) {
    const text = raw(p);
    if (p.origin === 'history') {
      steps.push({ burst: [{ origin: 'history', text, from: 0, to: length }] });
      length = text.length;
      continue;
    }
    let at = 0;
    for (const chunk of p.chunks ?? [text.length]) {
      steps.push({ burst: [{ origin: p.origin, text: text.slice(at, at + chunk) }] });
      at += chunk;
    }
    length += p.origin === 'typed' ? p.fixed.length + 1 : text.length;
  }
  return steps;
}

function build(spec: BurstSpec, id: string): EditorCase {
  const tokens = survivingTokens(spec);
  const corrections = spec.parts.filter((p) => p.origin === 'typed').length;
  const steps: Step[] = [{ fill: '', origin: 'unknown' }];
  if (spec.base) steps.push({ fill: filledBase, origin: 'unknown' });
  steps.push(...deliverySteps(spec));
  let text = joined(tokens);
  // Every correction delivered exactly once, including ones a later recall removed.
  steps.push({ check: { draft: { text, cursor: text.length }, stats: { corrections } } });
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (!token?.corrected) continue;
    token.corrected = false;
    token.text = token.raw;
    text = joined(tokens);
    steps.push({ burst: [], key: 'Undo' }, { check: { draft: { text, cursor: text.length } } });
  }
  const { ledgerChecks } = count(spec);
  return {
    id,
    steps,
    expect: {
      draft: { text, cursor: text.length, typedSpans: typedSpans(tokens) },
      stats: { corrections, ledgerChecks: ledgerChecks ?? 0 },
    },
  };
}

function count(spec: BurstSpec): Record<string, number> {
  const tokens = survivingTokens(spec);
  const undoChecks = tokens.filter((t) => t.corrected).length;
  const bursts =
    spec.delivery === 'coalesced'
      ? 1
      : spec.parts.reduce((n, p) => n + (p.origin === 'history' ? 1 : (p.chunks?.length ?? 1)), 0);
  const nonTyped = spec.parts.filter((p) => p.origin !== 'typed').length;
  return {
    runs: 1,
    keys: spec.parts.reduce((n, p) => n + raw(p).length, 0),
    corrections: spec.parts.length - nonTyped,
    undoChecks,
    coalesced: spec.delivery === 'coalesced' ? 1 : 0,
    chunked: spec.delivery === 'chunked' ? 1 : 0,
    history: spec.parts.filter((p) => p.origin === 'history').length,
    originChecks: nonTyped,
    filledChecks: spec.base ? 1 : 0,
    // One change event per fill, per native transaction and per undo; each must be a lossless ledger.
    ledgerChecks: 1 + (spec.base ? 1 : 0) + bursts + undoChecks,
  };
}

function* shrink(spec: BurstSpec): Iterable<BurstSpec> {
  for (let i = 0; i < spec.parts.length; i++) {
    yield { ...spec, parts: spec.parts.filter((_, j) => j !== i) };
  }
  if (spec.base) yield { ...spec, base: false };
  if (spec.delivery === 'chunked') {
    yield { ...spec, delivery: 'coalesced', parts: spec.parts.map(({ chunks: _, ...p }) => p) };
    for (let i = 0; i < spec.parts.length; i++) {
      const part = spec.parts[i];
      if (!part?.chunks || part.chunks.length < 2) continue;
      const whole = { ...part, chunks: [raw(part).length] };
      yield { ...spec, parts: spec.parts.map((p, j) => (j === i ? whole : p)) };
    }
  }
}

export const burst: Generator<BurstSpec, EditorCase> = { name: 'burst', generate, build, count, shrink };

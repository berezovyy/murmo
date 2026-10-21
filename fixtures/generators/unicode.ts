// Random drafts and cursors for offset and grapheme checks: the r7 shape
// (experiments/engine-v2/unicode.test.ts), 4,000 drafts with 8 cursors each,
// built from emoji, ZWJ sequences, flags, skin tones, keycaps, combining
// accents, CJK, CRLF and code-like punctuation. The first cursor is the end of
// the draft; the others are anywhere, including inside a character, because
// refusing those positions is what the offset functions must prove (lesson 20).
//
// r7 drew from a linear congruential generator; this port draws from
// xorshift32 like every other generator, so the drafts differ from r7's but the
// sizes and the alphabet are the same (docs/plan/02 § Generators).

import type { PureCase } from '../format.ts';
import { xorshift32 } from './prng.ts';
import type { Generated, Generator } from './types.ts';

export const unicodeChunks: readonly string[] = [
  'a',
  ' ',
  'teh',
  'recieve',
  '\u{1F600}',
  '\u{1F469}\u{200D}\u{1F4BB}',
  '\u{1F1FA}\u{1F1E6}',
  '\u{1F44D}\u{1F3FD}',
  '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}',
  'e\u{301}',
  '字',
  '日本語',
  '\r\n',
  '\n',
  '_x',
  './',
  '`',
  '(',
  ')',
  '1\u{FE0F}\u{20E3}',
];

export interface UnicodeSpec {
  chunks: number[];
  /** Every third draft ends in ` teh`, so correction checks have a target. */
  suffix: boolean;
  cursors: number[];
}

export const cursorsPerDraft = 8;

const textOf = (spec: UnicodeSpec): string =>
  spec.chunks.map((i) => unicodeChunks[i] ?? '').join('') + (spec.suffix ? ' teh' : '');

function* generate(seed: number, size: number): Iterable<Generated<UnicodeSpec, PureCase>> {
  const random = xorshift32(seed);
  for (let index = 0; index < size; index++) {
    const chunks: number[] = [];
    for (let n = 0, limit = 1 + random.int(16); n < limit; n++) chunks.push(random.int(unicodeChunks.length));
    const suffix = index % 3 === 0;
    const length = textOf({ chunks, suffix, cursors: [] }).length;
    const cursors = [length];
    for (let n = 1; n < cursorsPerDraft; n++) cursors.push(random.int(length + 1));
    const spec: UnicodeSpec = { chunks, suffix, cursors };
    yield { index, spec, case: build(spec, `unicode-${seed}-${index}`), counts: count(spec) };
  }
}

/** No `output`: the offset functions' verdicts are compared across runtimes, and checked by their own rules. */
function build(spec: UnicodeSpec, id: string): PureCase {
  return { id, input: { text: textOf(spec), cursors: spec.cursors } };
}

function count(spec: UnicodeSpec): Record<string, number> {
  return { drafts: 1, cursors: spec.cursors.length, units: textOf(spec).length };
}

function* shrink(spec: UnicodeSpec): Iterable<UnicodeSpec> {
  for (let i = 0; i < spec.chunks.length; i++) {
    const chunks = spec.chunks.filter((_, j) => j !== i);
    const length = textOf({ ...spec, chunks }).length;
    yield { ...spec, chunks, cursors: spec.cursors.map((c) => Math.min(c, length)) };
  }
  if (spec.suffix) {
    const length = textOf({ ...spec, suffix: false }).length;
    yield { ...spec, suffix: false, cursors: spec.cursors.map((c) => Math.min(c, length)) };
  }
  for (let i = 0; i < spec.cursors.length && spec.cursors.length > 1; i++) {
    yield { ...spec, cursors: spec.cursors.filter((_, j) => j !== i) };
  }
}

export const unicode: Generator<UnicodeSpec, PureCase> = { name: 'unicode', generate, build, count, shrink };

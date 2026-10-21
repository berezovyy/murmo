// Pure functions over @murmo/text for fixtures/text/ and the unicode generator.
// Each takes a case's JSON input and returns JSON, so the four runtimes
// compare results byte for byte.

import {
  codePoints,
  displayText,
  invisibleRuns,
  isGraphemeBoundary,
  isHighSurrogate,
  isLowSurrogate,
  offsetIndex,
  type Unit,
  unsafeText,
} from '@murmo/text';
import type { PureEntry } from '../pure.ts';

interface TextInput {
  text: string;
}

/** Every UTF-16 offset of the text converted to code points, UTF-8 bytes and graphemes (null inside a character). */
function offsets(input: unknown): unknown {
  const { text } = input as TextInput;
  const index = offsetIndex(text);
  const row = (to: Unit) => Array.from({ length: text.length + 1 }, (_, at) => index.convert(at, 'utf16', to));
  return { codePoint: row('codePoint'), utf8: row('utf8'), grapheme: row('grapheme') };
}

/** Per cursor: `[codePoint, utf8, grapheme, graphemeBefore, graphemeAfter]`, null where refused. */
type CursorVerdict = [number | null, number | null, number | null, number | null, number | null];

function boundaries(input: unknown): CursorVerdict[] {
  const { text, cursors } = input as TextInput & { cursors: number[] };
  const index = offsetIndex(text);
  return cursors.map((at) => [
    index.convert(at, 'utf16', 'codePoint'),
    index.convert(at, 'utf16', 'utf8'),
    index.convert(at, 'utf16', 'grapheme'),
    index.graphemeBefore(at),
    index.graphemeAfter(at),
  ]);
}

/** UTF-8 bytes before `at`, counted without @murmo/text so the rule is independent of the code under test. */
function bytesBefore(text: string, at: number): number {
  let bytes = 0;
  for (const ch of text.slice(0, at)) {
    const cp = ch.codePointAt(0) as number;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * The rules every boundary verdict obeys, checked on generated drafts that have
 * no expected output (r7: 4,000 drafts, 32,000 cursors, 0 split characters):
 * an offset inside a surrogate pair converts to nothing; every conversion that
 * succeeds round-trips exactly; graphemes never split a code point; the
 * no-index boundary check agrees with the index; navigation stays on boundaries.
 */
function boundaryRules(input: unknown, result: unknown): string[] {
  const { text, cursors } = input as TextInput & { cursors: number[] };
  const index = offsetIndex(text);
  const problems: string[] = [];
  (result as CursorVerdict[]).forEach(([cp, utf8, grapheme, before, after], i) => {
    const at = cursors[i] as number;
    const fail = (rule: string) => problems.push(`cursor ${at}: ${rule}`);
    const insidePair = at > 0 && isHighSurrogate(text.charCodeAt(at - 1)) && isLowSurrogate(text.charCodeAt(at));
    if ((cp === null) !== insidePair)
      fail(insidePair ? 'rounded a position inside a surrogate pair' : 'refused a code point boundary');
    if ((utf8 === null) !== (cp === null)) fail('UTF-8 and code point verdicts disagree');
    if (cp !== null && index.convert(cp, 'codePoint', 'utf16') !== at) fail('code point does not round-trip');
    if (utf8 !== null && index.convert(utf8, 'utf8', 'utf16') !== at) fail('UTF-8 offset does not round-trip');
    if (utf8 !== null && utf8 !== bytesBefore(text, at)) fail('UTF-8 offset is not the byte count');
    if (grapheme !== null && cp === null) fail('a grapheme boundary splits a code point');
    if (grapheme !== null && index.convert(grapheme, 'grapheme', 'utf16') !== at) fail('grapheme does not round-trip');
    if (isGraphemeBoundary(text, at) !== (grapheme !== null)) fail('isGraphemeBoundary disagrees with the index');
    if (grapheme === null && (before !== null || after !== null)) fail('navigation from inside a grapheme');
    if (grapheme !== null) {
      if ((before === null) !== (at === 0) || (before !== null && (before >= at || !index.isBoundary(before))))
        fail('graphemeBefore is not the previous boundary');
      if ((after === null) !== (at === text.length) || (after !== null && (after <= at || !index.isBoundary(after))))
        fail('graphemeAfter is not the next boundary');
    }
  });
  return problems;
}

function convert(input: unknown): (number | null)[] {
  const { text, from, to, offsets } = input as TextInput & { from: Unit; to: Unit; offsets: number[] };
  const index = offsetIndex(text);
  return offsets.map((offset) => index.convert(offset, from, to));
}

export const textFunctions: Readonly<Record<string, PureEntry>> = {
  'text.offsets': offsets,
  'text.boundaries': { run: boundaries, rules: boundaryRules },
  'text.convert': convert,
  'text.codePoints': (input) => Array.from(codePoints((input as TextInput).text), (s) => [s.at, s.codePoint, s.units]),
  'text.unsafe': (input) => unsafeText((input as TextInput).text),
  'text.display': (input) => displayText((input as TextInput).text),
  'text.invisible': (input) => invisibleRuns((input as TextInput).text),
};

// Extended grapheme clusters (UAX #29), the unit every host moves its cursor
// by (lesson 20). One bundled segmenter runs in every runtime, Intl.Segmenter
// is never used: QuickJS has none, and Node, Bun and the Claude runtime ship
// different ICU builds, so using the built-in one would let hosts disagree on
// where a character ends (docs/plan/04 § One segmenter everywhere).
//
// Most drafts are mostly ASCII, so segmentation runs only where it can matter:
// between two "simple" units (ASCII, or a BMP CJK ideograph) the boundary is
// certain unless they are CR LF, because every rule that can join two code
// points (GB6–GB9c, GB11–GB13) needs a non-simple code point on one side.
// Segmentation restarts at such a certain boundary with no state carried over,
// so each non-simple stretch is segmented on its own.

import { graphemeSegments } from 'unicode-segmenter/grapheme';
import { isCodePointBoundary, isOffset } from './codepoints.ts';

/** The bundled segmenter and the Unicode version it implements. Tests cross-check it against Intl.Segmenter and Rust. */
export const segmenter = { name: 'unicode-segmenter', version: '0.17.3', unicode: '17.0.0' } as const;

const CR = 0x0d;
const LF = 0x0a;

/** ASCII, or a CJK Unified Ideograph in the BMP: Grapheme_Cluster_Break=Other and no Indic or emoji property. */
const simple = (unit: number): boolean =>
  unit < 0x80 || (unit >= 0x4e00 && unit <= 0x9fff) || (unit >= 0x3400 && unit <= 0x4dbf);

/** A position strictly inside the text whose boundary needs no segmenter. */
function certain(text: string, at: number): boolean {
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return simple(before) && simple(after) && !(before === CR && after === LF);
}

/** Pushes the boundaries strictly after `from` up to and including `to`, both certain boundaries. */
function segmentStretch(text: string, from: number, to: number, push: (at: number) => void): void {
  if (to - from === 1) {
    push(to);
    return;
  }
  let first = true;
  for (const part of graphemeSegments(text.slice(from, to))) {
    if (!first) push(from + part.index);
    first = false;
  }
  push(to);
}

/** Every grapheme boundary of the text as a UTF-16 offset, ascending, including 0 and the end. */
export function graphemeBoundaries(text: string): number[] {
  const out = [0];
  const push = (at: number) => {
    out.push(at);
  };
  for (let from = 0; from < text.length; ) {
    let to = from + 1;
    while (to < text.length && !certain(text, to)) to++;
    segmentStretch(text, from, to, push);
    from = to;
  }
  return out;
}

/**
 * True when `at` is a grapheme boundary. Between two simple units it allocates
 * nothing; elsewhere it segments only the stretch around `at`. Callers that ask
 * many times about one text should build an `offsetIndex` instead.
 */
export function isGraphemeBoundary(text: string, at: number): boolean {
  if (!isOffset(text, at)) return false;
  if (at === 0 || at === text.length) return true;
  if (certain(text, at)) return true;
  if (!isCodePointBoundary(text, at)) return false;
  let from = at - 1;
  while (from > 0 && !certain(text, from)) from--;
  let to = at + 1;
  while (to < text.length && !certain(text, to)) to++;
  for (const part of graphemeSegments(text.slice(from, to))) {
    const boundary = from + part.index;
    if (boundary === at) return true;
    if (boundary > at) return false;
  }
  return false;
}

/** True when both ends are grapheme boundaries and `from <= to`: an edit there splits no character. */
export function safeRange(text: string, from: number, to: number): boolean {
  return from <= to && isGraphemeBoundary(text, from) && isGraphemeBoundary(text, to);
}

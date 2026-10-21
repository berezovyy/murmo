// Text at the terminal boundary. Plugin text (edits, menu rows, status) can
// carry terminal escapes and bidi tricks to the screen (lessons 60, 77), and
// zero-width or look-alike edits reached the send unseen in round 14 (r14
// plugin-security § S1). `unsafeText` and `displayText` keep the behavior of
// experiments/platform/shared-v2/brokers/text-policy.ts exactly; they are
// written as loops so no runtime's regular-expression engine is involved.

import { isExtendedPictographic } from 'unicode-segmenter/emoji';
import { codePointBefore, codePointUnits, isHighSurrogate, isLowSurrogate, type Range } from './codepoints.ts';
import { isGraphemeBoundary } from './graphemes.ts';

/** C0 and C1 controls and DEL, except tab, LF and CR. */
const isControl = (unit: number): boolean =>
  unit <= 0x08 || unit === 0x0b || unit === 0x0c || (unit >= 0x0e && unit <= 0x1f) || (unit >= 0x7f && unit <= 0x9f);

/** Bidi embeddings, overrides (U+202A–202E) and isolates (U+2066–2069). */
const isBidiControl = (unit: number): boolean =>
  (unit >= 0x202a && unit <= 0x202e) || (unit >= 0x2066 && unit <= 0x2069);

/**
 * Why text must not reach the terminal or the prompt, or null when it may:
 * controls other than tab, LF and CR; bidi overrides and isolates; unpaired
 * surrogates. Reasons are checked in that order.
 */
export function unsafeText(text: string): string | null {
  if (typeof text !== 'string') return 'text must be a string';
  let bidi = false;
  let surrogate = false;
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (isControl(unit)) return 'control or terminal escape sequence';
    if (isBidiControl(unit)) bidi = true;
    else if (isHighSurrogate(unit)) {
      if (isLowSurrogate(text.charCodeAt(at + 1))) at++;
      else surrogate = true;
    } else if (isLowSurrogate(unit)) surrogate = true;
  }
  if (bidi) return 'bidirectional override/isolate';
  return surrogate ? 'unpaired surrogate' : null;
}

/** The text with every C0/C1 control (tab, LF and CR included), DEL, bidi control and lone surrogate shown as `\uXXXX`. */
export function displayText(text: string): string {
  let out = '';
  let from = 0;
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(at + 1))) {
      at++;
      continue;
    }
    const escaped =
      unit <= 0x1f ||
      (unit >= 0x7f && unit <= 0x9f) ||
      isBidiControl(unit) ||
      isHighSurrogate(unit) ||
      isLowSurrogate(unit);
    if (!escaped) continue;
    out += `${text.slice(from, at)}\\u${unit.toString(16).padStart(4, '0')}`;
    from = at + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

// Invisible code points (Unicode 17.0): Default_Ignorable_Code_Point plus
// gc=Cf, without the Prepended_Concatenation_Mark signs (U+0600–0605, 06DD,
// 070F, 0890–0891, 08E2, 110BD, 110CD), which render. Inclusive ranges,
// ascending; a test checks them against Node's \p{} tables.
const invisibleRanges: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];

export const invisibleCodePointRanges = invisibleRanges;

export function isInvisibleCodePoint(codePoint: number): boolean {
  let low = 0;
  let high = invisibleRanges.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const [from, to] = invisibleRanges[mid] as readonly [number, number];
    if (codePoint < from) high = mid - 1;
    else if (codePoint > to) low = mid + 1;
    else return true;
  }
  return false;
}

const ZWJ = 0x200d;
const TAG_BASE = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
/** The RGI emoji tag sequences (Emoji 17.0): the England, Scotland and Wales flags. */
const rgiTagSequences = new Set(['gbeng', 'gbsct', 'gbwls']);

const isKeycapBase = (codePoint: number | undefined): boolean =>
  codePoint !== undefined && ((codePoint >= 0x30 && codePoint <= 0x39) || codePoint === 0x23 || codePoint === 0x2a);

/**
 * The end of an RGI tag sequence whose tag characters start at `at`, or -1.
 * Tag characters can hide a whole ASCII message after an emoji, so only the
 * three real subdivision flags count as legitimate.
 */
function rgiTagEnd(text: string, at: number): number {
  if (codePointBefore(text, at) !== TAG_BASE) return -1;
  let letters = '';
  for (let i = at; i < text.length; i += 2) {
    const codePoint = text.codePointAt(i) as number;
    if (codePoint === CANCEL_TAG) return rgiTagSequences.has(letters) ? i + 2 : -1;
    if (codePoint < 0xe0061 || codePoint > 0xe007a || letters.length >= 5) return -1;
    letters += String.fromCharCode(codePoint - 0xe0000);
  }
  return -1;
}

/**
 * Runs of invisible code points, as merged UTF-16 ranges: zero-width and
 * format characters, bidi marks, fillers, tag characters and variation
 * selectors. Not flagged: a ZWJ that joins its grapheme to what follows (emoji
 * ZWJ sequences, Indic conjuncts), VS15/VS16 right after an emoji or keycap
 * base, and the tags of an RGI subdivision flag. This informs review UI; it
 * flags legitimate text too (a word joiner, ZWNJ in Persian) and never blocks
 * anything by itself.
 */
export function invisibleRuns(text: string): Range[] {
  const runs: [number, number][] = [];
  const flag = (from: number, to: number) => {
    const last = runs[runs.length - 1];
    if (last && last[1] === from) last[1] = to;
    else runs.push([from, to]);
  };
  for (let at = 0; at < text.length; ) {
    const units = codePointUnits(text, at);
    const codePoint = units === 2 ? (text.codePointAt(at) as number) : text.charCodeAt(at);
    if (!isInvisibleCodePoint(codePoint)) {
      at += units;
      continue;
    }
    if (codePoint >= 0xe0020 && codePoint <= CANCEL_TAG) {
      const end = rgiTagEnd(text, at);
      if (end > 0) {
        at = end;
        continue;
      }
    } else if (codePoint === ZWJ) {
      if (!isGraphemeBoundary(text, at + 1)) {
        at += units;
        continue;
      }
    } else if (codePoint === 0xfe0e || codePoint === 0xfe0f) {
      const base = codePointBefore(text, at);
      if (base !== undefined && (isExtendedPictographic(base) || isKeycapBase(base))) {
        at += units;
        continue;
      }
    }
    flag(at, at + units);
    at += units;
  }
  return runs;
}

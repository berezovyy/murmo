// Code points over UTF-16 strings. JavaScript indexes strings in UTF-16 code
// units, so an emoji outside the BMP is two units; anything that walks a
// draft one unit at a time sees half a character. The r13 emoji-dot mismatch
// (`teh.🙂`) came from exactly that: a `char.length === 1` check skipped the
// two-unit emoji (r13-engine-inline § E2). Walk code points with these.

/** Half-open UTF-16 range `[from, to)`. Same shape as `Range` in @murmo/api. */
export type Range = readonly [from: number, to: number];

export const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
export const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** An integer offset in `[0, length]`. Every offset this package accepts must pass this first. */
export const isOffset = (text: string, at: number): boolean => Number.isInteger(at) && at >= 0 && at <= text.length;

/** True when `at` is an offset that does not fall between the two halves of a surrogate pair. */
export function isCodePointBoundary(text: string, at: number): boolean {
  if (!isOffset(text, at)) return false;
  if (at === 0 || at === text.length) return true;
  return !(isHighSurrogate(text.charCodeAt(at - 1)) && isLowSurrogate(text.charCodeAt(at)));
}

/** UTF-16 units of the code point starting at `at`: 2 for a valid surrogate pair, else 1 (a lone surrogate is its own unit). */
export function codePointUnits(text: string, at: number): 1 | 2 {
  return isHighSurrogate(text.charCodeAt(at)) && isLowSurrogate(text.charCodeAt(at + 1)) ? 2 : 1;
}

/** Bytes of one code point in UTF-8. A lone surrogate counts 3, the size of the U+FFFD that replaces it on encoding. */
export function utf8Bytes(codePoint: number): 1 | 2 | 3 | 4 {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** UTF-8 length of the text. Shortcut and inline size limits count bytes (the Codex transport cap, phase 07). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let at = 0; at < text.length; ) {
    const units = codePointUnits(text, at);
    bytes += units === 2 ? 4 : utf8Bytes(text.charCodeAt(at));
    at += units;
  }
  return bytes;
}

/** True when the text is exactly one code point (one key's worth of input). */
export function isSingleCodePoint(text: string): boolean {
  return text.length === 1 || (text.length === 2 && codePointUnits(text, 0) === 2);
}

export interface CodePointStep {
  /** UTF-16 offset where the code point starts. */
  at: number;
  codePoint: number;
  units: 1 | 2;
}

/**
 * The code points of `text` from offset `from`, in order. A lone surrogate is
 * one step whose value is the surrogate itself, so nothing is skipped and every
 * unit belongs to exactly one step.
 */
export function* codePoints(text: string, from = 0): Generator<CodePointStep, void, undefined> {
  if (!isCodePointBoundary(text, from)) throw new RangeError(`offset ${from} is not a code point boundary`);
  for (let at = from; at < text.length; ) {
    const units = codePointUnits(text, at);
    yield { at, codePoint: units === 2 ? (text.codePointAt(at) as number) : text.charCodeAt(at), units };
    at += units;
  }
}

/** The code point that ends at `at`, or undefined at the start of the text. */
export function codePointBefore(text: string, at: number): number | undefined {
  if (!isOffset(text, at) || at === 0) return undefined;
  const last = text.charCodeAt(at - 1);
  if (at >= 2 && isLowSurrogate(last) && isHighSurrogate(text.charCodeAt(at - 2))) return text.codePointAt(at - 2);
  return last;
}

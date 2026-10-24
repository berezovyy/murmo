// Skip and peel helpers ported from engine-v2 unicode.ts. Intl.Segmenter is
// never used: portable code has to agree with @murmo/text on every runtime.

import { graphemeBoundaries, isGraphemeBoundary, safeRange } from '@murmo/text';

const wrapLeft = /^[([{"']*/;
const wrapRight = /[)\]}"',;:!?]+$/;
const emojiGrapheme = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{20e3}/u;

function hasNonAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if ((text.charCodeAt(i) as number) > 127) return true;
  return false;
}

/** A path, mention, flag or identifier: emoji next to it are part of the name. */
function nameLike(body: string): boolean {
  return /^[/@!\-.]/.test(body) || /[_/]/.test(body) || /[a-z][A-Z]/.test(body);
}

/** Wrapping quotes/brackets and a leading emoji run (not a path or identifier). */
export function leadingDecorations(raw: string): number {
  const left = wrapLeft.exec(raw)?.[0].length ?? 0;
  if (!hasNonAscii(raw)) return left;
  const body = raw.slice(left);
  if (nameLike(body)) return left;
  let last = left;
  let plainDigit = false;
  const bounds = graphemeBoundaries(body);
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i] as number;
    const end = bounds[i + 1] as number;
    const part = body.slice(start, end);
    if (emojiGrapheme.test(part)) last = left + end;
    else if (/[0-9]/.test(part)) plainDigit = true;
  }
  if (plainDigit) return left;
  return last + (wrapLeft.exec(raw.slice(last))?.[0].length ?? 0);
}

/**
 * Trailing sentence punctuation, matching closers and a trailing emoji run, so
 * `teh😀` and `(teh)🔥` end where `😀teh` begins: emoji separate words on both
 * sides. A name keeps its emoji (`teh_😀`), as on the left.
 */
export function trailingDecorations(raw: string): number {
  let end = raw.length - (wrapRight.exec(raw)?.[0].length ?? 0);
  if (!hasNonAscii(raw) || nameLike(raw)) return raw.length - end;
  const bounds = graphemeBoundaries(raw.slice(0, end));
  let i = bounds.length - 1;
  while (i > 0 && emojiGrapheme.test(raw.slice(bounds[i - 1] as number, bounds[i] as number))) i--;
  if ((bounds[i] as number) < end) {
    end = bounds[i] as number;
    end -= wrapRight.exec(raw.slice(0, end))?.[0].length ?? 0;
  }
  return raw.length - end;
}

/** A letter or mark outside ASCII; emoji variation and keycap marks are not letters. */
function foreignLetter(ch: string): boolean {
  const c = ch.codePointAt(0) as number;
  return c > 127 && c !== 0xfe0e && c !== 0xfe0f && c !== 0x20e3 && /[\p{L}\p{M}]/u.test(ch);
}

/** Foreign letters/accents in the text (engine-v2 hasForeignLetters). */
export function hasForeignLetters(text: string): boolean {
  if (!hasNonAscii(text)) return false;
  for (const ch of text) if (foreignLetter(ch)) return true;
  return false;
}

/** Scripts written without spaces: one run of them is already a phrase. */
const unspacedScript =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * A line written (partly) in another language: two or more words with
 * non-ASCII letters, or any text in a script written without spaces. Its
 * ASCII words are then names and terms, not English prose (round 4: a
 * Ukrainian or Japanese sentence keeps `teh` as typed). One such word is a
 * loanword or a name (`café`, `señor`, `привіт`) and leaves the line English.
 */
export function isForeignLine(line: string): boolean {
  if (!hasNonAscii(line)) return false;
  let words = 0;
  for (const word of line.split(/\s+/)) {
    if (!hasForeignLetters(word)) continue;
    if (unspacedScript.test(word) || ++words >= 2) return true;
  }
  return false;
}

export function editRangeIsSafe(text: string, start: number, end: number): boolean {
  return safeRange(text, start, end) && isGraphemeBoundary(text, start) && isGraphemeBoundary(text, end);
}

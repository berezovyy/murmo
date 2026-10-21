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

/** Wrapping quotes/brackets and a leading emoji run (not a path or identifier). */
export function leadingDecorations(raw: string): number {
  const left = wrapLeft.exec(raw)?.[0].length ?? 0;
  if (!hasNonAscii(raw)) return left;
  const body = raw.slice(left);
  if (/^[/@!\-.]/.test(body) || /[_/]/.test(body) || /[a-z][A-Z]/.test(body)) return left;
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

/** Trailing sentence punctuation and matching closers, as the engine peeled. */
export function trailingDecorations(raw: string): number {
  return wrapRight.exec(raw)?.[0].length ?? 0;
}

/**
 * Foreign letters/accents disable an English line; emoji variation and keycap
 * marks do not (engine-v2 hasForeignLetters).
 */
export function hasForeignLetters(line: string): boolean {
  if (!hasNonAscii(line)) return false;
  for (const ch of line) {
    const c = ch.codePointAt(0) as number;
    if (c > 127 && c !== 0xfe0e && c !== 0xfe0f && c !== 0x20e3 && /[\p{L}\p{M}]/u.test(ch)) return true;
  }
  return false;
}

export function editRangeIsSafe(text: string, start: number, end: number): boolean {
  return safeRange(text, start, end) && isGraphemeBoundary(text, start) && isGraphemeBoundary(text, end);
}

// Strict offset conversion between the units hosts count in: Pi and Claude use
// UTF-16, the Codex wrapper UTF-8 bytes, cursors move by grapheme (lesson 20).
// A position inside a character converts to null, never to the nearest
// boundary: Espanso's real bug came from counting characters on one side and
// bytes on the other (knowledge § 3), and a rounded position is an edit that
// splits an emoji. Callers treat null as "don't edit".
//
// The r7 rules are kept (experiments/engine-v2/src/unicode.ts); its linear
// `indexOf` lookups are replaced by an index built once per text, O(n), with
// O(log n) binary-search lookups. Pure ASCII without CR LF needs no index at
// all: every unit is a code point, a byte and a grapheme.

import { codePointUnits, isCodePointBoundary, isOffset, utf8Bytes } from './codepoints.ts';
import { graphemeBoundaries } from './graphemes.ts';

export type Unit = 'utf16' | 'codePoint' | 'grapheme' | 'utf8';
export const units: readonly Unit[] = ['utf16', 'codePoint', 'grapheme', 'utf8'];

const isUnit = (unit: unknown): unit is Unit =>
  unit === 'utf16' || unit === 'codePoint' || unit === 'grapheme' || unit === 'utf8';

/** Conversions for one text. Build it once per draft version and reuse it for every lookup. */
export interface OffsetIndex {
  readonly text: string;
  /** `offset` counted in `from`, counted in `to`; null when it falls inside a character of either unit, or is out of range. */
  convert(offset: number, from: Unit, to: Unit): number | null;
  /** Whether a UTF-16 offset is a boundary of `unit` (default: grapheme). */
  isBoundary(utf16: number, unit?: Unit): boolean;
  /** The grapheme boundary before a grapheme boundary (the Backspace target); null at the start or inside a character. */
  graphemeBefore(utf16: number): number | null;
  /** The grapheme boundary after a grapheme boundary; null at the end or inside a character. */
  graphemeAfter(utf16: number): number | null;
}

/** Index of `value` in an ascending array, or -1. */
function exact(sorted: ArrayLike<number>, value: number): number {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const at = sorted[mid] as number;
    if (at === value) return mid;
    if (at < value) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

/** Pure ASCII with no CR LF pair: all four units count the same. */
class AsciiIndex implements OffsetIndex {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  convert(offset: number, from: Unit, to: Unit): number | null {
    return isUnit(from) && isUnit(to) && isOffset(this.text, offset) ? offset : null;
  }
  isBoundary(utf16: number, unit: Unit = 'grapheme'): boolean {
    return isUnit(unit) && isOffset(this.text, utf16);
  }
  graphemeBefore(utf16: number): number | null {
    return isOffset(this.text, utf16) && utf16 > 0 ? utf16 - 1 : null;
  }
  graphemeAfter(utf16: number): number | null {
    return isOffset(this.text, utf16) && utf16 < this.text.length ? utf16 + 1 : null;
  }
}

class FullIndex implements OffsetIndex {
  readonly text: string;
  /** UTF-16 offset of every code point boundary, 0 to the end. */
  private readonly codePointAt: Uint32Array;
  /** UTF-8 byte offset of the same boundaries. */
  private readonly byteAt: Uint32Array;
  /** UTF-16 offset of every grapheme boundary, 0 to the end. */
  private readonly graphemeAt: Uint32Array;

  constructor(text: string) {
    this.text = text;
    const codePointAt = new Uint32Array(text.length + 1);
    const byteAt = new Uint32Array(text.length + 1);
    let count = 0;
    let bytes = 0;
    for (let at = 0; at < text.length; ) {
      const size = codePointUnits(text, at);
      bytes += size === 2 ? 4 : utf8Bytes(text.charCodeAt(at));
      at += size;
      count++;
      codePointAt[count] = at;
      byteAt[count] = bytes;
    }
    this.codePointAt = codePointAt.subarray(0, count + 1);
    this.byteAt = byteAt.subarray(0, count + 1);
    this.graphemeAt = Uint32Array.from(graphemeBoundaries(text));
  }

  private toUtf16(offset: number, from: Unit): number | null {
    if (!Number.isInteger(offset) || offset < 0) return null;
    switch (from) {
      case 'utf16':
        return isCodePointBoundary(this.text, offset) ? offset : null;
      case 'codePoint':
        return offset < this.codePointAt.length ? (this.codePointAt[offset] as number) : null;
      case 'grapheme':
        return offset < this.graphemeAt.length ? (this.graphemeAt[offset] as number) : null;
      case 'utf8': {
        const index = exact(this.byteAt, offset);
        return index < 0 ? null : (this.codePointAt[index] as number);
      }
    }
  }

  private fromUtf16(utf16: number, to: Unit): number | null {
    switch (to) {
      case 'utf16':
        return utf16;
      case 'grapheme': {
        const index = exact(this.graphemeAt, utf16);
        return index < 0 ? null : index;
      }
      case 'codePoint':
      case 'utf8': {
        const index = exact(this.codePointAt, utf16);
        if (index < 0) return null;
        return to === 'codePoint' ? index : (this.byteAt[index] as number);
      }
    }
  }

  convert(offset: number, from: Unit, to: Unit): number | null {
    if (!isUnit(from) || !isUnit(to)) return null;
    const utf16 = this.toUtf16(offset, from);
    return utf16 === null ? null : this.fromUtf16(utf16, to);
  }

  isBoundary(utf16: number, unit: Unit = 'grapheme'): boolean {
    if (!isUnit(unit) || !isOffset(this.text, utf16)) return false;
    if (unit === 'utf16') return true;
    if (unit === 'grapheme') return exact(this.graphemeAt, utf16) >= 0;
    return isCodePointBoundary(this.text, utf16);
  }

  graphemeBefore(utf16: number): number | null {
    const index = Number.isInteger(utf16) ? exact(this.graphemeAt, utf16) : -1;
    return index > 0 ? (this.graphemeAt[index - 1] as number) : null;
  }

  graphemeAfter(utf16: number): number | null {
    const index = Number.isInteger(utf16) ? exact(this.graphemeAt, utf16) : -1;
    return index >= 0 && index < this.graphemeAt.length - 1 ? (this.graphemeAt[index + 1] as number) : null;
  }
}

/** True when every unit is ASCII and no CR is followed by LF. Allocates nothing. */
function plainAscii(text: string): boolean {
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (unit >= 0x80 || (unit === 0x0d && text.charCodeAt(at + 1) === 0x0a)) return false;
  }
  return true;
}

export function offsetIndex(text: string): OffsetIndex {
  return plainAscii(text) ? new AsciiIndex(text) : new FullIndex(text);
}

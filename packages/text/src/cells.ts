// Terminal cells. The core never guesses a width: a ghost one cell too wide
// crashed Pi's render loop (lesson 3), and Python's grapheme widths did not
// match OpenCode's wcwidth (r10-opencode-stock § O3; stock OpenCode counts the
// family emoji as 8 cells). Adapters pass the host's own measure: OpenCode's
// `editBuffer.measureText`, the Codex wrapper's vt100 widths, Pi's
// `visibleWidth`. An adapter without one (OpenCode before 2.1.0) reports range
// edits unsupported instead of estimating (r12-opencode-platform § H3).
//
// Every function measures whole prefixes, so a measure that is not the sum of
// per-character widths (ZWJ sequences, flags) is still exact. Searches are
// binary over grapheme boundaries and assume the host's width never shrinks
// when text is appended; even if it did, a result is only ever a prefix the
// measure itself reported as fitting.

import { graphemeBoundaries, isGraphemeBoundary } from './graphemes.ts';

/** Display cells of a string, as the host renders it. */
export type CellMeasure = (text: string) => number;

/** Cells before UTF-16 offset `at`; null when `at` is inside a grapheme. */
export function utf16ToCells(text: string, at: number, measure: CellMeasure): number | null {
  return isGraphemeBoundary(text, at) ? measure(text.slice(0, at)) : null;
}

/** The smallest index `i` with `test(i)` true, assuming `test` turns true at most once; `count` if never. */
function firstTrue(count: number, test: (index: number) => boolean): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (test(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * The UTF-16 offset where the first `cells` cells end. Null when that column
 * falls inside a grapheme (half of a wide character) or past the end.
 */
export function cellsToUtf16(text: string, cells: number, measure: CellMeasure): number | null {
  if (!Number.isInteger(cells) || cells < 0) return null;
  const boundaries = graphemeBoundaries(text);
  const widthAt = (index: number) => measure(text.slice(0, boundaries[index]));
  const index = firstTrue(boundaries.length, (i) => widthAt(i) >= cells);
  return index < boundaries.length && widthAt(index) === cells ? (boundaries[index] as number) : null;
}

/** The longest prefix of whole graphemes that fits in `width` cells. Never wider than `width`, never cuts a grapheme. */
export function clipToCells(text: string, width: number, measure: CellMeasure): string {
  if (!Number.isInteger(width) || width < 0) throw new RangeError(`width must be a non-negative integer, got ${width}`);
  if (measure(text) <= width) return text;
  const boundaries = graphemeBoundaries(text);
  // The first boundary whose prefix no longer fits; the one before it fits.
  const over = firstTrue(boundaries.length, (i) => measure(text.slice(0, boundaries[i])) > width);
  for (let index = over - 1; index >= 0; index--) {
    const prefix = text.slice(0, boundaries[index]);
    if (measure(prefix) <= width) return prefix;
  }
  return '';
}

// Typed spans: the UTF-16 ranges the adapter saw being typed. Provenance comes
// from the input path, never from the text (lesson 52): a typed space after a
// pasted `teh` must not make `teh` correctable, which is what the OpenCode
// prototype got wrong. Spans are kept sorted, disjoint and merged (two spans
// never touch), so "one span covers the word and its separator" is a single
// lookup.
//
// The splice rule is the one from experiments/platform/shared-v2/fake-adapter
// (`spliceSpans`): clip what the splice replaces, shift what follows, add the
// inserted range only when it was typed, merge. Spans are immutable and shared:
// a splice copies the list (O(spans)) but reuses every span it doesn't change.

import type { Range } from '@murmo/api';

export type Spans = readonly Range[];

export const noSpans: Spans = [];

function checkSplice(from: number, to: number, insertLength: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    throw new RangeError(`bad splice range [${from}, ${to})`);
  }
  if (!Number.isInteger(insertLength) || insertLength < 0) throw new RangeError(`bad insert length ${insertLength}`);
}

/**
 * The spans after replacing `[from, to)` with `insertLength` units. The
 * inserted range is added only when `typed` (the caller decides what counts as
 * typed, see `addsCoverage`); anything else removes coverage over what it
 * replaced and adds none.
 */
export function splice(spans: Spans, from: number, to: number, insertLength: number, typed: boolean): Spans {
  checkSplice(from, to, insertLength);
  const shift = insertLength - (to - from);
  const out: Range[] = [];
  const push = (span: Range) => {
    const last = out[out.length - 1];
    if (last && span[0] <= last[1]) {
      if (span[1] > last[1]) out[out.length - 1] = [last[0], span[1]];
    } else out.push(span);
  };
  let inserted = !typed || insertLength === 0;
  for (const span of spans) {
    const [a, b] = span;
    if (b <= from) {
      push(span);
      continue;
    }
    if (a < from) push([a, from]);
    if (!inserted) {
      push([from, from + insertLength]);
      inserted = true;
    }
    if (b > to) push(a >= to && shift === 0 ? span : [Math.max(a, to) + shift, b + shift]);
  }
  if (!inserted) push([from, from + insertLength]);
  return out;
}

/** True when one span covers all of the non-empty range `[from, to)`: the correction eligibility rule. */
export function covers(spans: Spans, from: number, to: number): boolean {
  if (!(from < to)) return false;
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const [a, b] = spans[mid] as Range;
    if (from < a) high = mid - 1;
    else if (from >= b) low = mid + 1;
    else return to <= b;
  }
  return false;
}

/** True when the spans are sorted, non-empty, within `[0, length]` and never touch: the form every function here keeps. */
export function validSpans(spans: Spans, length: number): boolean {
  let end = -1;
  for (const [a, b] of spans) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a <= end || a >= b || b > length || a < 0) return false;
    end = b;
  }
  return true;
}

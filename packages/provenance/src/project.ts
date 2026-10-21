// The typed-only view a `draft:read` plugin gets (2.0-pre): every UTF-16 unit
// outside a typed span becomes `█`, with length, cursor and selection kept. With
// default `draft:read`, a capture plugin stored a pasted fake secret; with this
// view the pasted span was masked (lesson 77, r14-plugin-security § S6). It
// narrows what a plugin sees; a secret the user types stays readable.
//
// Without host-labeled evidence the spans are cleared first, so every unit is
// masked (r14-platform-core K5/S1, K7/E4). Only whole, valid code points are
// revealed: a span edge inside a surrogate pair masks the whole pair, and a
// lone surrogate is masked, so a guest never gets broken text.
//
// The prototype built the mask with `split('')`, `map` and a span scan per
// unit; this is one pass over the span list.

import { type Draft, type InputOriginEvidence, MASKED_UNIT } from '@murmo/api';
import { isHighSurrogate, isLowSurrogate } from '@murmo/text';

/** Appends the code points of `text[from, to)`, masking lone surrogates; records what was revealed. */
function reveal(text: string, from: number, to: number, out: { text: string; spans: [number, number][] }): void {
  const record = (a: number, b: number) => {
    const last = out.spans[out.spans.length - 1];
    if (last && last[1] === a) last[1] = b;
    else out.spans.push([a, b]);
  };
  let start = from;
  for (let at = from; at < to; at++) {
    const unit = text.charCodeAt(at);
    if (isHighSurrogate(unit) && at + 1 < to && isLowSurrogate(text.charCodeAt(at + 1))) {
      at++;
      continue;
    }
    if (!isHighSurrogate(unit) && !isLowSurrogate(unit)) continue;
    if (at > start) {
      out.text += text.slice(start, at);
      record(start, at);
    }
    out.text += MASKED_UNIT;
    start = at + 1;
  }
  if (to > start) {
    out.text += text.slice(start, to);
    record(start, to);
  }
}

/** The typed-only view of a draft. `typedSpans` in the result are exactly the revealed ranges. */
export function projectTyped(draft: Draft, evidence: InputOriginEvidence): Draft {
  const { text } = draft;
  const out = { text: '', spans: [] as [number, number][] };
  let at = 0;
  if (evidence === 'host-labeled') {
    for (const [a, b] of draft.typedSpans) {
      let from = Math.max(a, at);
      let to = Math.min(b, text.length);
      // A span edge between the halves of a pair: the pair stays masked.
      if (from > 0 && isLowSurrogate(text.charCodeAt(from)) && isHighSurrogate(text.charCodeAt(from - 1))) from++;
      if (to < text.length && isLowSurrogate(text.charCodeAt(to)) && isHighSurrogate(text.charCodeAt(to - 1))) to--;
      if (from >= to) continue;
      out.text += MASKED_UNIT.repeat(from - at);
      reveal(text, from, to, out);
      at = to;
    }
  }
  out.text += MASKED_UNIT.repeat(text.length - at);
  return { ...draft, text: out.text, typedSpans: out.spans };
}

/**
 * One projection per draft version, shared by every typed-only reader: a
 * one-entry cache keyed on the draft object and the evidence. Drafts are
 * immutable, so the same object always projects the same way.
 */
export function typedProjector(): (draft: Draft, evidence: InputOriginEvidence) => Draft {
  let last: { draft: Draft; evidence: InputOriginEvidence; view: Draft } | undefined;
  return (draft, evidence) => {
    if (last?.draft !== draft || last.evidence !== evidence) {
      last = { draft, evidence, view: projectTyped(draft, evidence) };
    }
    return last.view;
  };
}

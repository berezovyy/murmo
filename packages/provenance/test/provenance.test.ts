// Rules of @murmo/provenance that the ledger fixtures don't reach: selections
// a delta doesn't touch, range rebasing, position bias, deltas that don't fit,
// and the typed-only view on span edges a host could report anywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Draft, DraftDelta } from '@murmo/api';
import { MASKED_UNIT } from '@murmo/api';
import { xorshift32 } from '@murmo/fixtures/generators';
import { isHighSurrogate, isLowSurrogate, unsafeText } from '@murmo/text';
import {
  applyDelta,
  mapPosition,
  mapRange,
  nextDraft,
  projectTyped,
  type TypingRules,
  typedProjector,
} from '../src/index.ts';

const rules: TypingRules = { evidence: 'host-labeled', keyBursts: false };
const draft = (text: string, extra: Partial<Draft> = {}): Draft => ({
  text,
  cursor: text.length,
  version: 1,
  certainty: 'authoritative',
  typedSpans: [],
  ...extra,
});
const plugin = (from: number, to: number, insert: string): DraftDelta => ({ origin: 'plugin', from, to, insert });

test('a selection shifts with an edit before it, stays for one after it, and is gone once an edit touches it', () => {
  const d = draft('hello world', { cursor: 11, selection: [6, 11] });
  assert.deepEqual(nextDraft(d, plugin(0, 0, '>> '), rules).selection, [9, 14]);
  assert.deepEqual(
    nextDraft(draft('hello world!', { selection: [0, 5] }), plugin(11, 12, '?'), rules).selection,
    [0, 5],
  );
  assert.equal(nextDraft(d, plugin(5, 7, '_'), rules).selection, undefined);
  assert.equal(nextDraft(d, plugin(11, 11, '!'), rules).selection, undefined, 'an insert at its edge touches it');
});

test('a folded host part shifts with an edit before it, stays for one after it, and is gone once an edit enters it', () => {
  // Typing around a collapsed paste must keep saying the draft folds it, or
  // rescue would save the label as if it were the prompt.
  const d = draft('see [Pasted ~1 lines] ok', { foldedParts: [[4, 21]] });
  assert.deepEqual(nextDraft(d, plugin(0, 0, '>> '), rules).foldedParts, [[7, 24]]);
  assert.deepEqual(
    nextDraft(d, plugin(4, 4, 'x'), rules).foldedParts,
    [[5, 22]],
    'an insert at its start goes before it',
  );
  assert.deepEqual(
    nextDraft(d, plugin(21, 21, '!'), rules).foldedParts,
    [[4, 21]],
    'an insert at its end goes after it',
  );
  assert.equal(nextDraft(d, plugin(10, 11, ''), rules).foldedParts, undefined, 'an edit inside it unfolds it');
  assert.equal(nextDraft(draft('plain'), plugin(0, 0, 'a'), rules).foldedParts, undefined);
});

test('a rebased range survives edits outside it and inserts at its edges, and is dropped by any edit inside (inline-rewrite rebase)', () => {
  const deltas = [plugin(0, 2, 'xyz'), plugin(9, 9, '!'), plugin(4, 4, '<')];
  assert.deepEqual(mapRange([4, 9], deltas.slice(0, 1)), [5, 10]);
  assert.deepEqual(mapRange([4, 9], [plugin(9, 9, '!')]), [4, 9], 'insert at the end');
  assert.deepEqual(mapRange([4, 9], [plugin(4, 4, '<')]), [5, 10], 'insert at the start');
  assert.equal(mapRange([4, 9], [plugin(5, 5, 'x')]), null, 'insert inside');
  assert.equal(mapRange([4, 9], [plugin(8, 10, '')]), null, 'overlap');
});

test('mapPosition keeps a position before an edit, shifts one after it, and puts one inside at the bias end', () => {
  const replace = [plugin(2, 5, 'XY')];
  assert.equal(mapPosition(1, replace, 'after'), 1);
  assert.equal(mapPosition(7, replace, 'before'), 6);
  assert.equal(mapPosition(3, replace, 'before'), 2);
  assert.equal(mapPosition(3, replace, 'after'), 4);
  assert.equal(mapPosition(2, [plugin(2, 2, 'ab')], 'after'), 4, 'typing at the cursor leaves it after the text');
  assert.equal(mapPosition(2, [plugin(2, 2, 'ab')], 'before'), 2);
});

test('a delta outside the text it addresses throws instead of being clamped', () => {
  assert.throws(() => applyDelta('abc', plugin(2, 4, 'x')), RangeError);
  assert.throws(() => applyDelta('abc', plugin(2, 1, 'x')), RangeError);
  assert.throws(() => applyDelta('abc', plugin(0.5, 1, 'x')), RangeError);
  assert.throws(() => nextDraft(draft('abc'), plugin(4, 4, 'x'), rules), RangeError);
});

test('the typed-only view keeps length, cursor and selection, reveals exactly the typed code points and never half a pair (E14, E15)', () => {
  const random = xorshift32(0x7e57ed);
  const pieces = ['a', ' ', '\u{1F600}', '\u{1F468}\u{200D}\u{1F469}', 'é', '中', '\u{D800}', 'sk_'];
  for (let n = 0; n < 5000; n++) {
    let text = '';
    for (let i = 0, length = 1 + random.int(10); i < length; i++) text += random.pick(pieces);
    // Arbitrary UTF-16 edges, as a buggy or unusual adapter could report them.
    const edges = [...new Set(Array.from({ length: 2 * random.int(4) }, () => random.int(text.length + 1)))].sort(
      (a, b) => a - b,
    );
    const spans: [number, number][] = [];
    for (let i = 0; i + 1 < edges.length; i += 2) spans.push([edges[i] as number, edges[i + 1] as number]);
    const d = draft(text, {
      cursor: random.int(text.length + 1),
      selection: [0, random.int(text.length + 1)],
      typedSpans: spans,
    });
    const view = projectTyped(d, 'host-labeled');
    assert.equal(view.text.length, text.length);
    assert.equal(view.cursor, d.cursor);
    assert.deepEqual(view.selection, d.selection);
    assert.notEqual(unsafeText(view.text), 'unpaired surrogate', `half a pair visible in ${JSON.stringify(view.text)}`);
    const typed = (i: number) => spans.some(([a, b]) => i >= a && i < b);
    const unit = (i: number) => text.charCodeAt(i);
    for (let at = 0; at < text.length; at++) {
      // A unit is revealed exactly when it is typed and its whole, valid code point is typed.
      const whole =
        isHighSurrogate(unit(at)) && isLowSurrogate(unit(at + 1))
          ? typed(at + 1)
          : isLowSurrogate(unit(at)) && isHighSurrogate(unit(at - 1))
            ? typed(at - 1)
            : !isHighSurrogate(unit(at)) && !isLowSurrogate(unit(at));
      const revealed = typed(at) && whole;
      assert.equal(
        view.typedSpans.some(([a, b]) => at >= a && at < b),
        revealed,
        `unit ${at} of ${JSON.stringify(text)}`,
      );
      assert.equal(view.text[at], revealed ? text[at] : MASKED_UNIT, `unit ${at} of ${JSON.stringify(text)}`);
    }
    assert.equal(projectTyped(d, 'observed-unmarked').text, MASKED_UNIT.repeat(text.length));
  }
});

test('one projection per draft version is shared by every typed-only reader', () => {
  const project = typedProjector();
  const d = draft('teh', { typedSpans: [[0, 3]] });
  assert.equal(project(d, 'host-labeled'), project(d, 'host-labeled'));
  assert.notEqual(project(d, 'host-labeled'), project(d, 'unknown'));
  assert.equal(project({ ...d, version: 2 }, 'host-labeled').text, 'teh');
});

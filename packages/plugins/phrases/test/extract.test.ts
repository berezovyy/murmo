// Clause extractor: typed-span filter, slash/! skip. Catches learning pasted
// text (E4, E26, E27).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractClauses, learnFromSubmit, spansCover } from '../src/extract.ts';

const typed = (text: string): [number, number][] => [[0, text.length]];

test('3–10 word clauses survive; shorter and longer runs are dropped', () => {
  const text = 'Update the cache. Hi. Two words.';
  assert.deepEqual(extractClauses(text, typed(text)), ['Update the cache']);
});

test('fences, inline code, URLs and paths are stripped before splitting', () => {
  const text = 'Update the cache `skip this` module. See https://example.com/x and ./src/x.ts please add tests now.';
  const clauses = extractClauses(text, typed(text));
  assert.ok(clauses.some((c) => c === 'Update the cache module'));
  assert.ok(!clauses.join(' ').includes('skip'));
  assert.ok(!clauses.join(' ').includes('example'));
  assert.ok(!clauses.join(' ').includes('src'));
});

test('a clause that crosses an untyped span is dropped whole (lesson 52)', () => {
  const text = 'Update the pasted module for tests';
  const spans: [number, number][] = [
    [0, 'Update the '.length],
    ['Update the pasted '.length, text.length],
  ];
  assert.equal(spansCover(spans, 0, text.length), false);
  assert.deepEqual(extractClauses(text, spans), []);
});

test('slash and bang commands, shell mode, inferred queue, missing spans teach nothing', () => {
  const text = 'Update the cache module';
  const base = { text, typedSpans: typed(text), gesture: 'send' as const, level: 'observed' as const };
  assert.equal(learnFromSubmit({ ...base, text: '/help me with this now' }).skip, 'slash-command');
  assert.equal(learnFromSubmit({ ...base, text: '!ls the files please now' }).skip, 'slash-command');
  assert.equal(learnFromSubmit({ ...base, mode: 'shell' }).skip, 'shell-mode');
  assert.equal(learnFromSubmit({ ...base, gesture: 'queue', level: 'inferred' }).skip, 'inferred-queue');
  assert.equal(learnFromSubmit({ text: base.text, gesture: base.gesture, level: base.level }).skip, 'no-typed-spans');
  assert.equal(learnFromSubmit({ ...base, typedSpans: [] }).skip, 'no-typed-spans');
  assert.equal(learnFromSubmit({ ...base, certainty: 'unknown' }).skip, 'unknown-certainty');
});

test('inferred send still learns; observed queue learns; unknown level never arrives', () => {
  const text = 'Update the cache module';
  const spans = typed(text);
  assert.deepEqual(learnFromSubmit({ text, typedSpans: spans, gesture: 'send', level: 'inferred' }).clauses, [
    'Update the cache module',
  ]);
  assert.deepEqual(learnFromSubmit({ text, typedSpans: spans, gesture: 'queue', level: 'observed' }).clauses, [
    'Update the cache module',
  ]);
});

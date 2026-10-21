// Widths come from the host, never a guess: a ghost one cell too wide crashed
// Pi's render loop (lesson 3, E9), and stock OpenCode's wcwidth counts the
// family emoji as 8 cells where a grapheme-aware host counts 2 (E8). The
// helpers must stay within the width under either kind of measure.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellsToUtf16, clipToCells, graphemeBoundaries, utf16ToCells } from '../src/index.ts';

const wide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd);
const zero = (ch: string): boolean => /^(?:\p{M}|\u200d|\ufe0e|\ufe0f)$/u.test(ch);

/** wcwidth per code point, summed: what stock OpenCode does (family emoji = 8 cells). */
const wcwidth = (text: string): number =>
  Array.from(text).reduce((n, ch) => n + (zero(ch) ? 0 : wide(ch.codePointAt(0) as number) ? 2 : 1), 0);

/** Grapheme-aware: 2 cells for an emoji or wide cluster, else 1 (Pi's visibleWidth, OpenCode's measureText). */
const clusters = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemeWidth = (text: string): number =>
  Array.from(clusters.segment(text)).reduce((n, { segment }) => {
    const cp = segment.codePointAt(0) as number;
    return n + (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) || wide(cp) ? 2 : 1);
  }, 0);

const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}';
const pieces = ['teh ', '中文', family, ' \u{1F1FA}\u{1F1E6}', 'e\u{301}', '日本語 ', '\u{1F44D}\u{1F3FD}', 'ok'];
/** A draft about `columns` wide, then wrapping: the terminal widths of knowledge § 9. */
const draftFor = (columns: number): string => {
  let text = '';
  for (let i = 0; wcwidth(text) < columns * 2; i++) text += pieces[i % pieces.length];
  return text;
};

test('clipToCells never returns text wider than the width or cuts a grapheme, at 87, 40, 30 and 20 columns (lesson 3, E9)', () => {
  for (const columns of [87, 40, 30, 20]) {
    const text = draftFor(columns);
    const boundaries = new Set(graphemeBoundaries(text));
    for (const measure of [wcwidth, graphemeWidth]) {
      for (let width = 1; width <= 120; width++) {
        const clipped = clipToCells(text, width, measure);
        const where = `${columns} columns, ${measure.name}, width ${width}`;
        assert.ok(measure(clipped) <= width, `${where}: ${measure(clipped)} cells`);
        assert.ok(text.startsWith(clipped) && boundaries.has(clipped.length), `${where}: cut inside a grapheme`);
        // Maximal: the next whole grapheme would not fit.
        const next = [...boundaries].find((b) => b > clipped.length);
        if (next !== undefined) assert.ok(measure(text.slice(0, next)) > width, `${where}: clipped too early`);
      }
    }
  }
});

test('cell positions inside a character are refused, not rounded', () => {
  const text = `a中${family}b`;
  assert.equal(utf16ToCells(text, 2, graphemeWidth), 3);
  assert.equal(utf16ToCells(text, 3, graphemeWidth), null, 'inside the family emoji');
  assert.equal(utf16ToCells(text, 2 + family.length, wcwidth), 11, 'the host decides: wcwidth counts the family as 8');
  assert.equal(cellsToUtf16(text, 3, graphemeWidth), 2);
  assert.equal(cellsToUtf16(text, 2, graphemeWidth), null, 'half of 中');
  assert.equal(cellsToUtf16(text, 4, graphemeWidth), null, 'half of the family emoji');
  assert.equal(cellsToUtf16(text, 6, graphemeWidth), text.length);
  assert.equal(cellsToUtf16(text, 7, graphemeWidth), null, 'past the end');
});

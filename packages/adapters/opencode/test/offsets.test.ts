// UTF-16 ↔ cell conversion must match the host measure, not a guessed wcwidth
// (lesson 20, r10 O3). Property-tested against @murmo/text helpers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellsToUtf16, graphemeBoundaries, utf16ToCells } from '@murmo/text';
import { fromCells, representable, toCells } from '../src/offsets.ts';
import { FakeOpenCode, FakeTextarea, wcwidth } from './fake-opencode.ts';

const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}';
const samples = ['teh ', '中文', family, 'e\u{301}', '日本語 ', 'ok', 'a teh z'];

test('ASCII offsets equal UTF-16 indices on the fake OpenTUI measure', () => {
  const host = new FakeOpenCode();
  const editor = new FakeTextarea({ initialValue: 'hello world' });
  host.api.renderer.currentFocusedEditor = editor;
  for (let i = 0; i <= editor.plainText.length; i++) {
    const cells = toCells(editor, editor.plainText, i);
    assert.equal(cells, i);
    assert.equal(fromCells(editor, cells), i);
    assert.equal(representable(editor, editor.plainText, i), true);
  }
});

test('round-trip at every grapheme boundary for mixed Unicode (lesson 20)', () => {
  const text = samples.join('');
  const editor = new FakeTextarea({ initialValue: text });
  const measure = (s: string) => wcwidth(s);
  for (const at of graphemeBoundaries(text)) {
    const cells = toCells(editor, text, at);
    const viaText = utf16ToCells(text, at, measure);
    assert.equal(cells, viaText);
    if (!representable(editor, text, at)) continue;
    assert.equal(fromCells(editor, cells), at);
    assert.equal(cellsToUtf16(text, cells, measure), at);
  }
});

test('an index inside a surrogate pair is not representable', () => {
  const text = 'a👍b';
  const editor = new FakeTextarea({ initialValue: text });
  assert.equal(representable(editor, text, 2), false);
});

// Row labels are clipped to cells, never bytes: one cell too wide crashes Pi
// (lesson 3). Project overrides get a source tag.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileShortcuts, defaultCellMeasure, formatRow, packNames } from '../src/index.ts';
import { seeds } from './helpers.ts';

const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
const firstLine = `Ship it \u{1F680} — ${family} \u{1F1FA}\u{1F1E6} café 日本語`;

function entryOf(name: string, line: string, overrides: readonly string[] = []) {
  const compiled = compileShortcuts({ replacements: seeds({ [name]: line }) });
  const table = packNames(compiled, overrides);
  const entry = table.entries[0];
  assert.ok(entry);
  return entry;
}

test('rows fit 20, 30, 40 and 87 columns with CJK and emoji', () => {
  const entry = entryOf('emo', firstLine);
  for (const width of [20, 30, 40, 87]) {
    const row = formatRow(entry, width, defaultCellMeasure);
    const cells = defaultCellMeasure(row);
    assert.ok(cells <= width, `width ${width}: ${cells} cells in ${JSON.stringify(row)}`);
    assert.equal(row.includes('\n'), false);
  }
});

test('a project override is tagged in the label', () => {
  const entry = entryOf(';rvw', 'Review this change', [';rvw']);
  const row = formatRow(entry, 87, defaultCellMeasure);
  assert.ok(row.includes(';rvw'));
  assert.ok(row.includes('project'));
  assert.ok(row.includes('Review'));
});

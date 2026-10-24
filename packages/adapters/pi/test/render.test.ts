// Width-safe decoration: a ghost one cell over crashes Pi (lesson 3, E7).
// OSC/APC in third-party UI must render as literal text (E21, lesson 77).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayText } from '@murmo/text';
import { visibleWidth } from '../src/ansi.ts';
import { decorateRows } from '../src/render.ts';
import { CURSOR_APC, FAKE_CURSOR_END, FAKE_CURSOR_START } from '../src/types.ts';
import { fakeTuiApi } from './fake-pi.ts';

function hostRow(width: number, prefix = 'teh '): string {
  const fake = `${FAKE_CURSOR_START} ${FAKE_CURSOR_END}`;
  const used = prefix.length + 1;
  return `${prefix}${CURSOR_APC}${fake}${' '.repeat(Math.max(0, width - used))}`;
}

test('every decorated row stays ≤ width at 60, 80 and 120 with both cursor formats (E7)', () => {
  for (const width of [60, 80, 120]) {
    const rows = decorateRows(
      [hostRow(width)],
      width,
      { ghost: { text: 'world' }, menu: { items: [{ label: 'tst  Run the tests' }], selected: 0 }, status: 'ok' },
      fakeTuiApi,
    );
    for (const row of rows) {
      assert.ok(visibleWidth(row, fakeTuiApi.visibleWidth) <= width, `${row} wider than ${width}`);
    }
  }
});

test('OSC 52/8, cursor and bracketed-paste payloads render as literal text (E21)', () => {
  const payload = '\x1b]52;c;SECRET\x07\x1b]8;;https://x\x07hi\x1b]8;;\x07\x1b[200~paste';
  const shown = displayText(payload);
  assert.ok(!shown.includes('\x1b'), 'displayText must strip ESC');
  const rows = decorateRows(
    [hostRow(80)],
    80,
    {
      ghost: { text: payload, owner: 'evil' },
      menu: { items: [{ label: payload }], selected: 0 },
      status: payload,
    },
    fakeTuiApi,
  );
  const joined = rows.join('\n');
  assert.ok(!joined.includes('\x1b]52'), 'OSC 52 must not reach the TUI');
  assert.ok(!joined.includes('\x1b[200~'), 'bracketed-paste marker must not reach the TUI');
  assert.ok(joined.includes('\\u001b') || joined.includes('hi'), 'escaped or visible text remains');
});

test('at 50 columns a long status wraps instead of losing its end, and every row fits', () => {
  // Pi cut "Autocorrect is off. Set [autocorrect] enabled =..." before the file name.
  const hint = 'Autocorrect is off. Set [autocorrect] enabled = true in murmo.toml to opt in.';
  const rows = decorateRows([hostRow(50)], 50, { status: `${hint} | second notice` }, fakeTuiApi);
  const status = rows.slice(1);
  for (const row of rows) assert.ok(visibleWidth(row, fakeTuiApi.visibleWidth) <= 50, `${row} wider than 50`);
  assert.equal(status.join(' '), `${hint} second notice`);
});

test('built-in menu rows carry no owner tag; the core labels third-party rows itself', () => {
  const rows = decorateRows(
    [hostRow(80)],
    80,
    { menu: { items: [{ label: ';tst  Run the project test suite only.' }], selected: 0 } },
    fakeTuiApi,
  );
  assert.equal(rows[1]?.trimEnd(), '> ;tst  Run the project test suite only.');
});

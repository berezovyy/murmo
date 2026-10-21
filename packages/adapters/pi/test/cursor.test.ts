// Cursor-format detection: APC pi:fc (1.x) and SGR 7m (0.84.1). A version
// switch in place of a behavior probe hid the ghost (E7, E19, lesson 23).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectCursorFormat } from '../src/cursor.ts';
import { CURSOR_APC, FAKE_CURSOR_END, FAKE_CURSOR_START } from '../src/types.ts';
import { fakeTuiApi } from './fake-pi.ts';

test('detectCursorFormat recognizes pi:fc (1.3.0 render output)', () => {
  const row = `teh ${CURSOR_APC}${FAKE_CURSOR_START} ${FAKE_CURSOR_END}    `;
  const hit = detectCursorFormat([row], fakeTuiApi);
  assert.equal(hit?.format, 'pi:fc');
  assert.equal(hit?.row, 0);
});

test('detectCursorFormat recognizes SGR 7m (0.84.1 render output)', () => {
  const row = `teh ${CURSOR_APC}\x1b[7m \x1b[0m    `;
  const hit = detectCursorFormat([row], { ...fakeTuiApi, renderFakeCursor: (ch) => `\x1b[7m${ch}\x1b[0m` });
  assert.equal(hit?.format, 'sgr-7m');
});

test('detectCursorFormat returns undefined when the marker is missing', () => {
  assert.equal(detectCursorFormat(['no cursor here'], fakeTuiApi), undefined);
});

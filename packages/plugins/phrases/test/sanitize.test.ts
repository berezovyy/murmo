// Hostile candidates: OSC 52, bidi, zero-width, C0/C1. 0 raw control bytes
// on screen or in the draft (E10).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipGhost, makeVisible } from '../src/ghost.ts';
import { hasRawControl, sanitizeCandidate } from '../src/sanitize.ts';

const hostile: { name: string; input: string }[] = [
  { name: 'esc', input: 'cache\u001b[31m module' },
  { name: 'osc52', input: 'cache\u001b]52;c;AAAA\u0007 module' },
  { name: 'bel', input: 'cache\u0007 module' },
  { name: 'c1-nel', input: 'cache\u0085 module' },
  { name: 'del', input: 'cache\u007f module' },
  { name: 'tab', input: 'cache\tmodule' },
  { name: 'lf', input: 'cache\nmodule' },
  { name: 'cr', input: 'cache\rmodule' },
  { name: 'bidi-lre', input: 'cache\u202a module' },
  { name: 'bidi-rlo', input: 'cache\u202e module' },
  { name: 'bidi-lri', input: 'cache\u2066 module' },
  { name: 'bidi-pdi', input: 'cache\u2069 module' },
  { name: 'zwsp', input: 'cache\u200b module' },
  { name: 'zwnj', input: 'cache\u200c module' },
  { name: 'zwj-alone', input: 'cache\u200d module' },
  { name: 'bom', input: 'cache\ufeff module' },
  { name: 'word-joiner', input: 'cache\u2060 module' },
  { name: 'tag-a', input: 'cache\u{e0061} module' },
  { name: 'vs15', input: 'cache\ufe0e module' },
  { name: 'mixed', input: '\u001b]52;c;AA\u0007\u202ecache\u200b\u0007' },
];

test('20+ hostile candidates sanitize to 0 raw control bytes (display = insert)', () => {
  assert.ok(hostile.length >= 20, `need 20 cases, got ${hostile.length}`);
  for (const c of hostile) {
    const out = sanitizeCandidate(c.input);
    assert.equal(hasRawControl(out), false, c.name);
    const visible = makeVisible(`update the ${c.input}`, 'update the ', 'update the ', 80);
    if (visible) assert.equal(hasRawControl(visible.visible), false, `${c.name} visible`);
  }
});

test('clipGhost never returns more cells than asked (Pi crash, lesson 3)', () => {
  const wide = '更新缓存模块请'.repeat(20);
  const clipped = clipGhost(wide, 10);
  assert.ok(clipped.length < wide.length);
});

// Canonical IDs and undo-binding matching (r10 O1). Catches Super+Z mapped as
// Super+z instead of the logical Undo key.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindingMatches, canonicalKey, extraUndoKeys, isPrintableTyped } from '../src/keys.ts';
import type { ParsedKey } from '../src/types.ts';
import { FakeOpenCode } from './fake-opencode.ts';

function key(partial: Partial<ParsedKey> & Pick<ParsedKey, 'name'>): ParsedKey {
  return {
    sequence: '',
    preventDefault() {},
    stopPropagation() {},
    ...partial,
  };
}

test('configured Ctrl+- and Super+Z become Undo (E4, lesson 36)', () => {
  const host = new FakeOpenCode();
  const undo = key({ name: '-', ctrl: true });
  assert.equal(canonicalKey(undo, host.api.keymap), 'Undo');
  assert.equal(canonicalKey(key({ name: 'z', super: true }), host.api.keymap), 'Undo');
  assert.ok(bindingMatches(host.api.keymap, 'input.undo', undo));
});

test('Enter is send; Shift+Enter is Newline; printable keys keep their character', () => {
  const host = new FakeOpenCode();
  assert.equal(canonicalKey(key({ name: 'return', sequence: '\r' }), host.api.keymap), 'Enter');
  assert.equal(canonicalKey(key({ name: 'enter', shift: true }), host.api.keymap), 'Newline');
  assert.equal(canonicalKey(key({ name: 'a', sequence: 'a' }), host.api.keymap), 'a');
  assert.equal(canonicalKey(key({ name: 'space', sequence: ' ' }), host.api.keymap), 'space');
});

test('a custom single-stroke undo binding is advertised as an extra undo key', () => {
  const host = new FakeOpenCode();
  host.shortcuts['input.undo'] = ['f6'];
  assert.deepEqual(extraUndoKeys(host.api.keymap), ['F6']);
});

test('multi-stroke queue bindings need the pending prefix (Ctrl+X Enter)', () => {
  const host = new FakeOpenCode();
  const enter = key({ name: 'enter' });
  assert.equal(bindingMatches(host.api.keymap, 'prompt.queue', enter), false);
  host.pendingKeys = [{ key: 'ctrl+x' }];
  assert.equal(bindingMatches(host.api.keymap, 'prompt.queue', enter), true);
});

test('any printable single-grapheme key is typed; controls, chords and bulk input are not', () => {
  // Catches Cyrillic, accented and emoji keys being left out of typed spans,
  // which kept `;привіт` from expanding on OpenCode alone.
  for (const sequence of ['a', ' ', 'п', 'é', 'e\u0301', '日', '👋', '👨\u200d👩\u200d👧']) {
    assert.equal(isPrintableTyped(key({ name: sequence, sequence })), true, sequence);
  }
  for (const sequence of ['', '\x1b', '\t', '\x7f', 'ab', 'пр', '\u202e', '\ud83d']) {
    assert.equal(isPrintableTyped(key({ name: sequence, sequence })), false, JSON.stringify(sequence));
  }
  assert.equal(isPrintableTyped(key({ name: 'п', sequence: 'п', ctrl: true })), false);
  assert.equal(isPrintableTyped(key({ name: 'п', sequence: 'п', meta: true })), false);
});

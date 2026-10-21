// Canonical key IDs from Pi parseKey / bindings (fixtures/core/keys/normalization).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCanonicalKey } from '@murmo/api';
import { decodeKey, fromPiKeyId, isBracketedPaste, stripPasteMarkers } from '../src/keys.ts';
import { fakeTuiApi } from './fake-pi.ts';

test('Pi key names normalize to canonical IDs (fn.keys.normalize)', () => {
  assert.equal(fromPiKeyId('tab'), 'Tab');
  assert.equal(fromPiKeyId('space'), 'space');
  assert.equal(fromPiKeyId('f6'), 'F6');
  assert.equal(fromPiKeyId('ctrl+c'), 'Ctrl+c');
  assert.equal(fromPiKeyId('alt+c'), 'Alt+c');
  assert.equal(fromPiKeyId('shift+tab'), 'Shift+Tab');
  assert.equal(fromPiKeyId('a'), 'a');
  assert.ok(isCanonicalKey(fromPiKeyId('ctrl+shift+p')));
});

test('bindings: Enter is submit, \\n is newline, 0x1F is Undo, Alt+Enter is queue', () => {
  const bindings = {
    matches(data: string, action: string) {
      if (action === 'tui.input.submit') return data === '\r';
      if (action === 'tui.input.newLine') return data === '\n';
      if (action === 'tui.editor.undo') return data === '\x1f';
      if (action === 'app.message.followUp') return data === '\x1b\r';
      return false;
    },
  };
  const parse = fakeTuiApi.parseKey;
  assert.equal(decodeKey('\r', parse, bindings, undefined).kind, 'submit');
  assert.equal(decodeKey('\n', parse, bindings, undefined).kind, 'newline');
  assert.equal(decodeKey('\x1f', parse, bindings, undefined).id, 'Undo');
  assert.equal(decodeKey('\x1b\r', parse, bindings, undefined).kind, 'queue');
});

test('bracketed paste is detected and CRLF/tabs are normalized (E9)', () => {
  const raw = '\x1b[200~hello\r\n\tworld\x1b[201~';
  assert.equal(isBracketedPaste(raw), true);
  assert.equal(stripPasteMarkers(raw), 'hello\n    world');
});

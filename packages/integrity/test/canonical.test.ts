// Canonical encoding must be byte-stable so two packs of one commit match
// and phase 28 can reuse the same encoder for plugin envelopes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../src/canonical.ts';

test('object keys are sorted and there is no insignificant whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ files: [{ path: 'z' }, { path: 'a' }] }), '{"files":[{"path":"z"},{"path":"a"}]}');
});

test('integers stay integers; a float is refused', () => {
  assert.equal(canonicalJson(0), '0');
  assert.equal(canonicalJson(-1), '-1');
  assert.throws(() => canonicalJson(1.5), /safe integers/);
});

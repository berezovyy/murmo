// Virtual extmarks are opaque prompt parts. Catches an edit that would drop a
// file mention or collapsed paste (E6).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasOpaqueParts, rangeTouchesPart } from '../src/parts.ts';
import { FakeTextarea } from './fake-opencode.ts';

test('a caret inside a virtual mark is refused; a range beside it is allowed', () => {
  const editor = new FakeTextarea({ initialValue: 'see @file.ts please' });
  editor.addVirtual(4, 12);
  assert.equal(hasOpaqueParts(editor), true);
  assert.equal(rangeTouchesPart(editor, 6, 6), true);
  assert.equal(rangeTouchesPart(editor, 4, 12), true);
  assert.equal(rangeTouchesPart(editor, 0, 3), false);
  assert.equal(rangeTouchesPart(editor, 12, 19), false);
});

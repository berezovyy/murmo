// autocorrect.lookupWord against the shipped table and case policy (r8).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { lookupWord } from '../src/lookup.ts';
import { loadEnglishPack } from '../src/node/load.ts';
import { englishPackAsset } from '../src/table-source.ts';

before(() => {
  loadEnglishPack();
});

test('required examples from r8 verify.mjs', () => {
  assert.ok(englishPackAsset());
  assert.deepEqual(lookupWord({ token: 'teh', context: {} }), { fix: 'the' });
  assert.deepEqual(lookupWord({ token: 'adn', context: {} }), { fix: 'and' });
  assert.deepEqual(lookupWord({ token: 'recieve', context: {} }), { fix: 'receive' });
  assert.deepEqual(lookupWord({ token: 'thier', context: {} }), { fix: 'their' });
  assert.deepEqual(lookupWord({ token: 'Recieve', context: {} }), { fix: 'Receive' });
});

test('lowercase-only and origin/language/prose gates (case-policy-r8.json)', () => {
  assert.deepEqual(lookupWord({ token: 'Teh', context: {} }), { fix: null });
  assert.deepEqual(lookupWord({ token: 'Thier', context: {} }), { fix: null });
  assert.deepEqual(lookupWord({ token: 'Adn', context: {} }), { fix: null });
  assert.deepEqual(lookupWord({ token: 'teh', context: { origin: 'paste' } }), { fix: null });
  assert.deepEqual(lookupWord({ token: 'teh', context: { language: 'uk' } }), { fix: null });
  assert.deepEqual(lookupWord({ token: 'teh', context: { prose: false } }), { fix: null });
  assert.deepEqual(lookupWord({ token: 'teh', context: { vocabulary: ['teh'] } }), { fix: null });
  assert.deepEqual(lookupWord({ token: '/teh', context: {} }), { fix: null });
  assert.deepEqual(lookupWord({ token: 'aaccess', context: {} }), { fix: null });
});

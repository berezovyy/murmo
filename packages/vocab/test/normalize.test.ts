// One key function: 10,000 random tokens agree with the corrector (r6 missed
// collisions when raw and lowercase keys differed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEnglishPolicy } from '@murmo/plugin-autocorrect';
import { MAX_KEY_LENGTH, MIN_KEY_LENGTH, normalizeKey } from '../src/normalize.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-/';

test('10,000 random tokens: vocab key equals the corrector lookup key (r6)', () => {
  const rand = mulberry32(19);
  const policy = createEnglishPolicy();
  let compared = 0;
  for (let i = 0; i < 10_000; i++) {
    const n = 1 + Math.floor(rand() * 80);
    let token = '';
    for (let k = 0; k < n; k++) token += alphabet[Math.floor(rand() * alphabet.length)] as string;
    const vocab = normalizeKey(token);
    const asciiLetters = /^[A-Za-z]+$/.test(token) && token.length >= MIN_KEY_LENGTH && token.length <= MAX_KEY_LENGTH;
    const expected = asciiLetters ? token.toLowerCase() : null;
    assert.equal(vocab, expected, token);
    const proposed = policy.propose({
      text: `${token} `,
      cursor: token.length,
      typed: ' ',
      rejected: new Set(),
      vocabulary: new Set(),
      lookup: (word) => (vocab === word ? 'x' : null),
    });
    if (vocab && /^[a-z]+$|^[A-Z][a-z]+$/.test(token) && !/[_/\d]/.test(token)) {
      compared++;
      if (proposed) {
        const expect = /^[A-Z]/.test(token) ? 'X' : 'x';
        assert.equal(proposed.insert, expect);
      }
    } else {
      assert.equal(proposed, null, token);
    }
  }
  assert.ok(compared > 0);
});

test('normalizeKey is lowercase ASCII [a-z]{2,64}', () => {
  assert.equal(normalizeKey('Teh'), 'teh');
  assert.equal(normalizeKey('ratatui'), 'ratatui');
  assert.equal(normalizeKey('OutboxWorker'), 'outboxworker');
  assert.equal(normalizeKey('a'), null);
  assert.equal(normalizeKey('ser_'), null);
  assert.equal(normalizeKey('teh.ts'), null);
  assert.equal(normalizeKey('i18n'), null);
});

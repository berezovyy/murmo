// English word policy: skip, case, i→I, lowercase-only (r8 E6). Catches a
// loader that ignores case-policy.json and a generic fallback that would
// change real words (lesson 14).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WordPolicyQuery } from '@murmo/core';
import { encodeTable, lookup, mapTable } from '@murmo/lang';
import { createEnglishPolicy, DEFAULT_LOWERCASE_ONLY, inCode } from '../src/policy.ts';

const pairs: readonly (readonly [string, string])[] = [
  ['teh', 'the'],
  ['adn', 'and'],
  ['thier', 'their'],
  ['recieve', 'receive'],
  ['wich', 'which'],
  ['i', 'I'],
];
const table = mapTable(encodeTable(pairs));
const policy = createEnglishPolicy({ lowercaseOnly: DEFAULT_LOWERCASE_ONLY });

function query(text: string, extra: Partial<WordPolicyQuery> = {}): WordPolicyQuery {
  return {
    text,
    cursor: extra.cursor ?? text.length,
    typed: extra.typed ?? ' ',
    rejected: extra.rejected ?? new Set(),
    vocabulary: extra.vocabulary ?? new Set(),
    lookup: (word) => lookup(table, word) ?? null,
    ...extra,
  };
}

function fix(text: string, extra: Partial<WordPolicyQuery> = {}): string | null {
  return policy.propose(query(text, extra))?.insert ?? null;
}

test('lowercase typos correct; Recieve keeps title case (E6)', () => {
  assert.equal(fix('teh'), 'the');
  assert.equal(fix('Fix teh'), 'the');
  assert.equal(fix('recieve'), 'receive');
  assert.equal(fix('Recieve'), 'Receive');
});

test('lowercase-only keys stay literal in title and ALLCAPS (r8, Proposal a)', () => {
  assert.equal(fix('Teh'), null);
  assert.equal(fix('Thier'), null);
  assert.equal(fix('Adn'), null);
  assert.equal(fix('TEH'), null);
  assert.equal(fix('ADN'), null);
  assert.equal(fix('teh'), 'the');
  assert.equal(fix('adn'), 'and');
});

test('i→I only as a standalone word; inner capitals and ALLCAPS stay', () => {
  assert.equal(fix('i'), 'I');
  assert.equal(fix('I'), null);
  assert.equal(fix('TehClient'), null);
  assert.equal(fix('recieveData'), null);
  assert.equal(fix('tEh'), null);
});

test('skip paths, flags, identifiers, digits, length, vocabulary and rejected (E9)', () => {
  assert.equal(fix('/teh'), null);
  assert.equal(fix('@recieve'), null);
  assert.equal(fix('--adn'), null);
  assert.equal(fix('.teh'), null);
  assert.equal(fix('teh_parser'), null);
  assert.equal(fix('teh2'), null);
  assert.equal(fix('a'.repeat(65)), null);
  assert.equal(fix('teh', { vocabulary: new Set(['teh']) }), null);
  assert.equal(fix('teh', { rejected: new Set(['teh']) }), null);
  assert.equal(fix('adn', { vocabulary: new Set(['adn']) }), null);
});

test('quoted and bracketed prose still corrects (r4-18, r4-39)', () => {
  assert.equal(fix('Explain "teh'), 'the');
  assert.equal(fix('Explain [(teh'), 'the');
  assert.equal(fix('(wich'), 'which');
});

test('fences and inline code skip (r4-06, r4-07, r4-42)', () => {
  assert.equal(inCode('Keep `const teh'), true);
  assert.equal(inCode('```ts\nconst teh'), true);
  assert.equal(inCode('~~~\nteh recieve\n~~~\nFix teh'), false);
  assert.equal(fix('Keep `const teh'), null);
  assert.equal(fix('Then explain teh'), 'the');
});

test('a foreign line is skipped, one foreign word is not; emoji is not a letter (E7, round 4)', () => {
  // Catches one loanword blocking a line (`über recieve`) and a foreign sentence losing its protection.
  assert.equal(fix('Перевір teh'), 'the');
  assert.equal(fix('Перевір цей teh'), null);
  assert.equal(fix('説明 teh'), null);
  assert.equal(fix('😀teh'), 'the');
  assert.equal(fix('teh😀'), 'the');
  assert.equal(fix('(teh)😀'), 'the');
  assert.equal(fix('teh_😀'), null);
});

test('generic edit-distance fallback is off: unparseable stays (lesson 14)', () => {
  assert.equal(fix('unparseable'), null);
  assert.equal(fix('Ratatui'), null);
  assert.equal(fix('aaccess'), null);
});

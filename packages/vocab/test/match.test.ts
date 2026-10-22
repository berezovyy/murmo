// Ranking quality on a packed fixture: style, 1-edit, exact/english/prose gates
// (E2, E7). Split fixture 29/29 lives in split.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCodeLike as coreCodeLike } from '@murmo/core';
import { buildPacked, candidatesFrom, isCodeLike, loadPacked, rankNames, wordKey } from '../src/index.ts';

const records = [
  { name: 'OutboxWorker', kind: 'class', file: 'src/outbox/worker.rs', line: 12, refs: 9 },
  { name: 'HttpServerConfig', kind: 'type', file: 'src/http/config.rs', line: 4, refs: 5 },
  {
    name: 'OutboxWorker::drain_queue',
    kind: 'method',
    file: 'src/outbox/worker.rs',
    line: 40,
    refs: 3,
    owner: 'OutboxWorker',
  },
];

test('codeLike agrees with the coordinator predicate', () => {
  for (const s of ['OutboxWorkr', 'outbox_worker', 'a.b', 'A::b', 'src/outbox.rs']) {
    assert.equal(isCodeLike(s), coreCodeLike(s), s);
  }
  assert.equal(isCodeLike('the'), false);
  assert.equal(isCodeLike('worker'), false);
});

test('style-independent key and one-edit typo rank first', () => {
  const idx = loadPacked(buildPacked(records));
  const english = (w: string) => w === 'the' || w === 'config';
  const run = (token: string) => {
    const ids = idx.retrieve(wordKey(token), 96);
    return rankNames(token, candidatesFrom(idx, ids), { exactName: (n) => idx.findName(n), isEnglish: english });
  };
  assert.equal(run('outbox_worker')[0]?.name, 'OutboxWorker');
  assert.equal(run('OutboxWorkr')[0]?.name, 'OutboxWorker');
  assert.equal(run('OutboxWorker').length, 0, 'exact name');
  assert.equal(run('the').length, 0, 'english/prose');
  assert.equal(run('please review this').length, 0);
});

test('packed bytes never contain a source line', () => {
  const bytes = buildPacked(records);
  const text = new TextDecoder().decode(bytes);
  assert.equal(text.includes('fn '), false);
  assert.equal(text.includes('let '), false);
});

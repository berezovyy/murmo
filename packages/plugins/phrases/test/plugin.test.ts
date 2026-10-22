// Session-level learning: only typed committed sends, opt-in. Catches a
// default-on leak and learning from paste (E4).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryStore } from '../src/memory.ts';
import { PROJECT, withPhrases } from './helpers.ts';

const TEXT = 'Update the cache module for tests';

test('learn=false writes 0 records on a typed send', async () => {
  const memory = createMemoryStore();
  const h = await withPhrases(memory, { learn: false });
  await h.driver.type(TEXT);
  await h.driver.submit('send');
  await h.driver.settle();
  assert.equal(memory.records().length, 0);
});

test('learn=true stores typed clauses from a committed send and skips paste', async () => {
  const memory = createMemoryStore();
  const h = await withPhrases(memory, { learn: true });
  await h.driver.type(TEXT);
  await h.driver.submit('send');
  await h.driver.settle();
  assert.ok(
    memory.records().some((r) => r.phrase === TEXT),
    JSON.stringify(memory.records()),
  );

  const pasted = createMemoryStore();
  const p = await withPhrases(pasted, { learn: true });
  await p.driver.paste(TEXT);
  await p.driver.submit('send');
  await p.driver.settle();
  assert.equal(pasted.records().length, 0);
  assert.equal(PROJECT.length, 64);
});

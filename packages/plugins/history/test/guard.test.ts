// 1,000,000 ordinary keys with the menu closed give 0 lookups (E9).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryStore } from '../src/memory.ts';
import { searchIfOpen } from '../src/search.ts';

test('1,000,000 closed-menu queries do 0 lookups (r9 guard.mjs)', () => {
  const memory = createMemoryStore();
  memory.record([{ text: 'Review the cache module for tests.', host: 'pi', project: 'a'.repeat(64), at: 1 }]);
  const before = memory.lookups;
  for (let i = 0; i < 1_000_000; i++) {
    searchIfOpen(false, memory, { query: 'review', now: 1 });
  }
  assert.equal(memory.lookups, before);
});

// Ranking is explainable tiers with ordered fixtures (lesson 11). The same
// cases live in fixtures/menu/ranking.json for the four-runtime pure subject.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileShortcuts, filterNames, packNames } from '../src/index.ts';
import { seeds } from './helpers.ts';

function ids(
  entries: Readonly<Record<string, string>>,
  query: string,
  options: { origin?: 'user' | 'project'; overrides?: readonly string[] } = {},
): string[] {
  const compiled = compileShortcuts({
    replacements: seeds(entries, options.origin ?? 'user'),
    ...(options.overrides ? { overrides: options.overrides } : {}),
  });
  return filterNames(packNames(compiled, options.overrides ?? []), query).map((row) => row.entry.name);
}

test('exact match ranks above a longer prefix hit', () => {
  assert.deepEqual(ids({ rvw: 'Review', rvwx: 'Longer' }, 'rvw'), ['rvw', 'rvwx']);
});

test('a project row ranks above a personal one at the same tier', () => {
  const compiled = compileShortcuts({
    replacements: [
      { shortcut: 'zz', text: 'Z', origin: 'project' },
      { shortcut: 'aa', text: 'A', origin: 'user' },
    ],
  });
  assert.deepEqual(
    filterNames(packNames(compiled), '').map((row) => row.entry.name),
    ['zz', 'aa'],
  );
});

test('at most 8 rows are returned', () => {
  const entries: Record<string, string> = {};
  for (let i = 0; i < 10; i++) entries[`a${i}`] = String(i);
  assert.equal(ids(entries, 'a').length, 8);
});

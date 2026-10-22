// 50,000 unique or 365 days, whichever is smaller; expired rows drop on merge.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RETAIN_DAYS, RETAIN_UNIQUE, retain } from '../src/node/store.ts';
import type { HistoryRecord } from '../src/rank.ts';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function rec(id: number, lastAt: number): HistoryRecord {
  return {
    id,
    text: `prompt ${id} review the cache`,
    count: 1,
    lastAt,
    events: [{ host: 'pi', project: 'a'.repeat(64), at: lastAt }],
  };
}

test('records older than 365 days are dropped on retain', () => {
  const kept = retain([rec(0, NOW - (RETAIN_DAYS + 1) * DAY), rec(1, NOW)], NOW);
  assert.deepEqual(
    kept.map((r) => r.id),
    [1],
  );
});

test('retain keeps the 50,000 most recent when over the unique cap', () => {
  const rows = Array.from({ length: RETAIN_UNIQUE + 10 }, (_, i) => rec(i, NOW - i * 1000));
  const kept = retain(rows, NOW);
  assert.equal(kept.length, RETAIN_UNIQUE);
  assert.equal(kept[0]?.id, 0);
});

// Ordered ranking: scope, recency, count, acceptance, dismissal. Catches a
// silent swap of those tiers (E24, E25). Forty-plus named cases.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY_MS, MIN_COUNT, rankPhrases } from '../src/rank.ts';
import { PROJECT, record } from './helpers.ts';
import { rankingCases } from './ranking-cases.ts';

const now = 1_000_000_000_000;

test('40+ ranking fixtures keep scope above count, then recency, acceptance and hide-on-dismiss', () => {
  assert.ok(rankingCases.length >= 40, `need 40 cases, got ${rankingCases.length}`);
  for (const c of rankingCases) {
    const ranked = rankPhrases(c.records.map(record), {
      prefix: c.prefix,
      host: c.host ?? 'pi',
      project: c.project ?? PROJECT,
      now: c.now ?? now,
    });
    assert.deepEqual(
      ranked.map((r) => r.record.phrase),
      c.expect,
      c.name,
    );
  }
});

test('count below 3 is never shown; three dismissals with no accept hide the phrase', () => {
  const prefix = 'update the';
  const low = record({ phrase: 'update the cache module', count: MIN_COUNT - 1, lastAt: now });
  const hidden = record({
    phrase: 'update the worker pool now',
    count: 9,
    dismissals: 3,
    accepts: 0,
    lastAt: now,
  });
  const shown = record({ phrase: 'update the request path now', count: 3, lastAt: now });
  const ranked = rankPhrases([low, hidden, shown], { prefix, host: 'pi', project: PROJECT, now });
  assert.deepEqual(
    ranked.map((r) => r.record.phrase),
    ['update the request path now'],
  );
});

test('recency decay 0.25+0.75·exp(−age/7d) lets a recent count-3 beat an 8-year-old count-8', () => {
  const prefix = 'add tests for';
  const old = record({ phrase: 'add tests for the worker', count: 8, lastAt: now - 8 * 365 * DAY_MS });
  const fresh = record({ phrase: 'add tests for the client', count: 3, lastAt: now });
  const ranked = rankPhrases([old, fresh], { prefix, host: 'pi', project: PROJECT, now });
  assert.equal(ranked[0]?.record.phrase, 'add tests for the client');
});

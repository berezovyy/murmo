import { DAY_MS, type PhraseRecord } from '../src/rank.ts';
import { PROJECT } from './helpers.ts';

const now = 1_000_000_000_000;
const OTHER = 'b'.repeat(64);

type PartialRecord = Partial<PhraseRecord> & Pick<PhraseRecord, 'phrase'>;

export interface RankingCase {
  readonly name: string;
  readonly prefix: string;
  readonly records: readonly PartialRecord[];
  readonly expect: readonly string[];
  readonly host?: string;
  readonly project?: string;
  readonly now?: number;
}

const P = 'update the cache module';
const Q = 'update the worker pool';
const R = 'update the request path';
const S = 'add tests for this';
const T = 'add tests for that';

function scope(name: string, winner: string, loser: string, win: PartialRecord, lose: PartialRecord): RankingCase {
  return {
    name,
    prefix: 'update the',
    records: [lose, win],
    expect: [winner, loser],
  };
}

export const rankingCases: RankingCase[] = [
  scope(
    'project-beats-host',
    P,
    Q,
    { phrase: P, project: PROJECT, count: 3 },
    { phrase: Q, project: OTHER, host: 'pi', count: 99 },
  ),
  scope(
    'project-beats-global',
    P,
    Q,
    { phrase: P, project: PROJECT, count: 3 },
    { phrase: Q, project: OTHER, host: 'claude', count: 99 },
  ),
  {
    name: 'host-beats-global',
    prefix: 'update the',
    records: [
      { phrase: P, host: 'pi', project: OTHER, count: 3 },
      { phrase: Q, host: 'claude', project: OTHER, count: 99 },
    ],
    expect: [P, Q],
  },
  {
    name: 'same-scope-higher-count',
    prefix: 'update the',
    records: [
      { phrase: P, count: 8, lastAt: now },
      { phrase: Q, count: 3, lastAt: now },
    ],
    expect: [P, Q],
  },
  {
    name: 'same-count-more-recent',
    prefix: 'update the',
    records: [
      { phrase: P, count: 4, lastAt: now - DAY_MS },
      { phrase: Q, count: 4, lastAt: now },
    ],
    expect: [Q, P],
  },
  {
    name: 'accept-bonus-over-equal-count',
    prefix: 'update the',
    records: [
      { phrase: P, count: 3, accepts: 0, lastAt: now },
      { phrase: Q, count: 3, accepts: 4, lastAt: now },
    ],
    expect: [Q, P],
  },
  {
    name: 'dismissed-hidden',
    prefix: 'update the',
    records: [
      { phrase: P, count: 9, dismissals: 3, accepts: 0, lastAt: now },
      { phrase: Q, count: 3, lastAt: now },
    ],
    expect: [Q],
  },
  {
    name: 'dismissed-with-accept-still-shown',
    prefix: 'update the',
    records: [
      { phrase: P, count: 3, dismissals: 3, accepts: 1, lastAt: now },
      { phrase: Q, count: 3, lastAt: now - DAY_MS },
    ],
    expect: [P, Q],
  },
  {
    name: 'min-count-filters',
    prefix: 'update the',
    records: [
      { phrase: P, count: 2, lastAt: now },
      { phrase: Q, count: 3, lastAt: now },
    ],
    expect: [Q],
  },
  {
    name: 'prefix-required',
    prefix: 'update the',
    records: [
      { phrase: S, count: 9, lastAt: now },
      { phrase: P, count: 3, lastAt: now },
    ],
    expect: [P],
  },
  {
    name: 'exact-phrase-is-not-a-ghost',
    prefix: P,
    records: [{ phrase: P, count: 9, lastAt: now }],
    expect: [],
  },
  {
    name: 'case-sensitive-prefix',
    prefix: 'Update the',
    records: [
      { phrase: 'Update the cache module', count: 3, lastAt: now },
      { phrase: 'update the cache module', count: 9, lastAt: now },
    ],
    expect: ['Update the cache module'],
  },
  {
    name: 'tie-breaks-on-phrase',
    prefix: 'update the',
    records: [
      { phrase: R, count: 3, lastAt: now },
      { phrase: Q, count: 3, lastAt: now },
    ],
    expect: [R, Q],
  },
  {
    name: 'same-host-loses-to-this-repo',
    prefix: 'update the',
    records: [
      { phrase: P, project: PROJECT, host: 'claude', count: 3, lastAt: now },
      { phrase: Q, project: OTHER, host: 'pi', count: 9, lastAt: now },
    ],
    expect: [P, Q],
  },
  {
    name: 'global-only-when-no-better-scope',
    prefix: 'update the',
    records: [{ phrase: P, project: OTHER, host: 'claude', count: 3, lastAt: now }],
    expect: [P],
  },
  {
    name: 'offer-shortcut-5-in-14-days',
    prefix: 'add tests',
    records: [
      {
        phrase: S,
        count: 5,
        lastAt: now,
        recentAt: [now, now - DAY_MS, now - 2 * DAY_MS, now - 3 * DAY_MS, now - 4 * DAY_MS],
      },
    ],
    expect: [S],
  },
  ...Array.from({ length: 8 }, (_, i) => ({
    name: `project-over-count-${i}`,
    prefix: 'update the',
    records: [
      { phrase: P, project: PROJECT, count: 3 + i, lastAt: now },
      { phrase: Q, project: OTHER, count: 20 + i, lastAt: now },
    ],
    expect: [P, Q],
  })),
  ...Array.from({ length: 8 }, (_, i) => ({
    name: `recency-${i}`,
    prefix: 'add tests',
    records: [
      { phrase: S, count: 3, lastAt: now - i * DAY_MS },
      { phrase: T, count: 3, lastAt: now - (i + 3) * DAY_MS },
    ],
    expect: [S, T],
  })),
  ...Array.from({ length: 8 }, (_, i) => ({
    name: `count-tier-${i}`,
    prefix: 'update the',
    records: [
      { phrase: P, count: 3 + i, lastAt: now },
      { phrase: Q, count: 3, lastAt: now },
    ],
    expect: i === 0 ? [P, Q].sort() : [P, Q],
  })),
];

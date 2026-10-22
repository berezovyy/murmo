// Template picker: opencode-snippets tiers 0–8, aliases, descriptions, 10 rows (E11).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileShortcuts, packNames, rankTemplates, TEMPLATE_ROWS } from '../src/index.ts';

function compiled(
  rows: readonly {
    name: string;
    text?: string;
    description?: string;
    aliases?: readonly string[];
    origin?: 'user' | 'project';
  }[],
) {
  return compileShortcuts({
    replacements: rows.map((r) => ({
      shortcut: r.name,
      text: r.text ?? r.description ?? r.name,
      origin: r.origin ?? 'user',
      ...(r.description ? { description: r.description } : {}),
      ...(r.aliases ? { aliases: r.aliases } : {}),
    })),
  });
}

function ids(rows: Parameters<typeof compiled>[0], query: string): string[] {
  return rankTemplates(packNames(compiled(rows)), query).map((r) => r.entry.name);
}

test('ordered ranking fixture: exact, compact, prefix, substring, subsequence, description, project, aliases', () => {
  const cases: { query: string; rows: Parameters<typeof compiled>[0]; want: string[] }[] = [
    { query: 'rvw', rows: [{ name: 'rvw' }, { name: 'rvwx' }], want: ['rvw', 'rvwx'] },
    { query: 'rvw', rows: [{ name: 'r-v-w' }], want: ['r-v-w'] },
    { query: 'rv', rows: [{ name: 'rvw' }, { name: 'xrv' }], want: ['rvw', 'xrv'] },
    { query: 'rvw', rows: [{ name: 'xrvw' }], want: ['xrvw'] },
    { query: 'rvw', rows: [{ name: 'r-v-wx' }], want: ['r-v-wx'] },
    { query: 'abc', rows: [{ name: 'aXbYc' }], want: ['aXbYc'] },
    {
      query: 'review',
      rows: [{ name: 'zz', description: 'Code review request' }, { name: 'review' }],
      want: ['review', 'zz'],
    },
    {
      query: 'request',
      rows: [{ name: 'aa', description: 'Code review request' }],
      want: ['aa'],
    },
    {
      query: '',
      rows: [
        { name: 'zz', origin: 'project' },
        { name: 'aa', origin: 'user' },
      ],
      want: ['zz', 'aa'],
    },
    {
      query: 'rv',
      rows: [{ name: ';review', aliases: [';rv'] }, { name: 'rvw' }],
      want: [';review', 'rvw'],
    },
    { query: 'nope', rows: [{ name: 'rvw' }], want: [] },
    {
      query: 'ch',
      rows: [{ name: 'fix', description: 'change helper' }, { name: 'chg' }],
      want: ['chg', 'fix'],
    },
    {
      query: 'code',
      rows: [
        { name: 'aa', description: 'code review' },
        { name: 'bb', description: 'decode' },
      ],
      want: ['aa', 'bb'],
    },
    {
      query: 'rev',
      rows: [
        { name: 'review', origin: 'user' },
        { name: 'rev', origin: 'project' },
      ],
      want: ['rev', 'review'],
    },
    { query: 's', rows: [{ name: ';s0001' }, { name: ';s0000' }], want: [';s0000', ';s0001'] },
    { query: 'ab', rows: [{ name: 'cab' }, { name: 'abc' }], want: ['abc', 'cab'] },
    { query: 'q', rows: [{ name: 'qq' }, { name: 'q' }], want: ['q', 'qq'] },
    { query: 'tmpl', rows: [{ name: 'x', aliases: ['tmpl'] }], want: ['x'] },
    { query: 'z', rows: [{ name: 'az' }, { name: 'za' }], want: ['za', 'az'] },
    {
      query: 'bug',
      rows: [{ name: 'rvw', description: 'bugs and tests' }],
      want: ['rvw'],
    },
    { query: 'r_v', rows: [{ name: 'r_v_w' }], want: ['r_v_w'] },
    { query: '12', rows: [{ name: 'a12' }, { name: '12' }], want: ['12', 'a12'] },
    {
      query: 'field',
      rows: [{ name: 't', description: 'fields: change, concern' }],
      want: ['t'],
    },
    { query: 'xyz', rows: [{ name: 'x-y-z' }], want: ['x-y-z'] },
    { query: 'm', rows: [{ name: 'am' }, { name: 'ma' }, { name: 'm' }], want: ['m', 'ma', 'am'] },
    {
      query: 'pr',
      rows: [
        { name: 'prod', origin: 'project' },
        { name: 'pr', origin: 'user' },
      ],
      want: ['pr', 'prod'],
    },
    { query: 'ok', rows: [{ name: 'ok' }, { name: 'okay' }, { name: 'book' }], want: ['ok', 'okay', 'book'] },
    { query: 'dc', rows: [{ name: ';dc' }, { name: 'dc' }], want: ['dc', ';dc'] },
    { query: 'wxyz', rows: [{ name: 'wxyzz' }, { name: 'wxyz' }], want: ['wxyz', 'wxyzz'] },
    { query: 'des', rows: [{ name: 'n', description: 'design notes' }, { name: 'des' }], want: ['des', 'n'] },
  ];
  assert.ok(cases.length >= 30);
  for (const c of cases) {
    assert.deepEqual(ids(c.rows, c.query), c.want, c.query || '(empty)');
  }
});

test('at most 10 template rows are returned', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ name: `a${i}`, description: 'alpha' }));
  assert.equal(ids(rows, 'a').length, TEMPLATE_ROWS);
});

test('p95 rank of 1,006 entries stays within a frame of the empty-query baseline', () => {
  const rows = Array.from({ length: 1006 }, (_, i) => ({
    name: `;s${String(i).padStart(4, '0')}`,
    text: `Synthetic ${i} first line`,
    description: i % 7 === 0 ? 'Code review request' : '',
  }));
  const table = packNames(compiled(rows));
  const times: number[] = [];
  rankTemplates(table, 's00');
  for (let i = 0; i < 40; i++) {
    const t0 = performance.now();
    rankTemplates(table, 's00');
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
  assert.ok(p95 <= 16, `p95 ${p95.toFixed(3)} ms`);
});

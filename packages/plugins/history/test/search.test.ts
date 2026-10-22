// Packed top-ten identical to a brute scan on the 29 r9 queries, plus a
// this-repo scope boost (E3).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPacked, mapPacked, searchPacked } from '../src/packed.ts';
import { bruteSearch, type HistoryRecord } from '../src/rank.ts';
import { PROJECT, QUERIES } from './helpers.ts';

const NOW = 1_792_414_800_000;

function corpus(): HistoryRecord[] {
  const verbs = ['Review', 'Fix', 'Explain', 'Test', 'Refactor'];
  const subjects = ['OutboxWorker', 'drain_queue', 'AuthService', 'SessionManager', 'RequestHandler'];
  const paths = ['src/outbox/worker.rs', 'src/auth/session.ts', 'lib/cache.py'];
  const goals = ['for concurrent requests', 'when the server restarts', 'while preserving Unicode offsets'];
  const rows: HistoryRecord[] = [];
  let seed = 987123;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 4294967296) * n);
  };
  const texts = new Map<string, HistoryRecord>();
  for (let i = 0; i < 400; i++) {
    const text = `${verbs[rand(verbs.length)]} ${subjects[rand(subjects.length)]} in ${paths[rand(paths.length)]} ${goals[rand(goals.length)]}. Case ${rand(2000)}: keep the diff small.`;
    const existing = texts.get(text);
    const at = NOW - 100_000_000 + i * 1000;
    const project = i % 5 === 0 ? PROJECT : 'b'.repeat(64);
    const host = (['claude', 'codex', 'opencode', 'pi'] as const)[i % 4] as string;
    if (existing) {
      texts.set(text, {
        ...existing,
        count: existing.count + 1,
        lastAt: at,
        events: [...existing.events, { host, project, at }],
      });
    } else {
      const rec: HistoryRecord = {
        id: texts.size,
        text,
        count: 1,
        lastAt: at,
        events: [{ host, project, at }],
      };
      texts.set(text, rec);
    }
  }
  for (const r of texts.values()) rows.push(r);
  rows.sort((a, b) => a.id - b.id);
  return rows;
}

test('packed top-ten matches brute scan on all 29 r9 queries (E3)', () => {
  const records = corpus();
  const packed = mapPacked(buildPacked(records, NOW).files);
  assert.ok(packed);
  if (!packed) return;
  for (const q of QUERIES) {
    const brute = bruteSearch(records, { query: q, now: NOW }).map((h) => h.id);
    const packedIds: number[] = searchPacked(packed, q, { now: NOW }).map((h) => h.id);
    assert.deepEqual(packedIds, brute, q);
  }
});

test('this-repository scope boost ranks a same-project hit above an older global match', () => {
  const records: HistoryRecord[] = [
    {
      id: 0,
      text: 'Review OutboxWorker in src/outbox/worker.rs for timeouts.',
      count: 8,
      lastAt: NOW,
      events: [{ host: 'pi', project: 'c'.repeat(64), at: NOW }],
    },
    {
      id: 1,
      text: 'Review OutboxWorker in src/auth/session.ts for timeouts.',
      count: 2,
      lastAt: NOW - 1000,
      events: [{ host: 'pi', project: PROJECT, at: NOW - 1000 }],
    },
  ];
  const global = bruteSearch(records, { query: 'review outboxworker', now: NOW });
  const scoped = bruteSearch(records, { query: 'review outboxworker', now: NOW, project: PROJECT });
  assert.equal(global[0]?.id, 0);
  assert.equal(scoped[0]?.id, 1);
});

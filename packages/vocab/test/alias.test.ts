// Prose alias ranking: outbox worker → OutboxWorker; stopwords; 1-edit; ≤1% noise (E7).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPacked,
  candidatesFrom,
  loadPacked,
  proseSpan,
  rankAliases,
  SOURCE_DOCS,
  SOURCE_TAGS,
  wordKey,
} from '../src/index.ts';

const names = [
  { name: 'OutboxWorker', kind: 'class', file: 'src/outbox/worker.rs', line: 12, refs: 9, source: SOURCE_TAGS },
  { name: 'HttpServerConfig', kind: 'type', file: 'src/http/config.rs', line: 4, refs: 5, source: SOURCE_TAGS },
  { name: 'SessionManager', kind: 'class', file: 'src/session.rs', line: 1, refs: 4, source: SOURCE_TAGS },
  { name: 'AuthService', kind: 'class', file: 'src/auth.ts', line: 2, refs: 3, source: SOURCE_DOCS },
  { name: 'drain_queue', kind: 'function', file: 'src/outbox/worker.rs', line: 40, refs: 3, source: SOURCE_TAGS },
  { name: 'RetryPolicy', kind: 'type', file: 'src/retry.rs', line: 1, refs: 2, source: SOURCE_TAGS },
  { name: 'CacheEntry', kind: 'class', file: 'src/cache.rs', line: 1, refs: 2, source: SOURCE_TAGS },
  { name: 'EventBus', kind: 'class', file: 'src/bus.rs', line: 1, refs: 2, source: SOURCE_TAGS },
];

const positives: { query: string; want: string }[] = [
  { query: 'outbox worker', want: 'OutboxWorker' },
  { query: 'the outbox worker', want: 'OutboxWorker' },
  { query: 'OutboxWorker', want: 'OutboxWorker' },
  { query: 'outbox_worker', want: 'OutboxWorker' },
  { query: 'outbx worker', want: 'OutboxWorker' },
  { query: 'outbox workr', want: 'OutboxWorker' },
  { query: 'http server config', want: 'HttpServerConfig' },
  { query: 'http server', want: 'HttpServerConfig' },
  { query: 'the http server config', want: 'HttpServerConfig' },
  { query: 'session manager', want: 'SessionManager' },
  { query: 'the session manager', want: 'SessionManager' },
  { query: 'auth service', want: 'AuthService' },
  { query: 'drain queue', want: 'drain_queue' },
  { query: 'retry policy', want: 'RetryPolicy' },
  { query: 'cache entry', want: 'CacheEntry' },
  { query: 'event bus', want: 'EventBus' },
  { query: 'outbox', want: 'OutboxWorker' },
  { query: 'server config', want: 'HttpServerConfig' },
  { query: 'please the outbox worker', want: 'OutboxWorker' },
  { query: 'http servr config', want: 'HttpServerConfig' },
  { query: 'sesion manager', want: 'SessionManager' },
  { query: 'aut service', want: 'AuthService' },
  { query: 'drain queu', want: 'drain_queue' },
  { query: 'retr policy', want: 'RetryPolicy' },
  { query: 'cach entry', want: 'CacheEntry' },
  { query: 'event bs', want: 'EventBus' },
  { query: 'http_server_config', want: 'HttpServerConfig' },
  { query: 'session_manager', want: 'SessionManager' },
  { query: 'auth_service', want: 'AuthService' },
  { query: 'retry_policy', want: 'RetryPolicy' },
  { query: 'cache_entry', want: 'CacheEntry' },
  { query: 'event_bus', want: 'EventBus' },
  { query: 'worker', want: 'OutboxWorker' },
  { query: 'manager', want: 'SessionManager' },
  { query: 'service', want: 'AuthService' },
  { query: 'queue', want: 'drain_queue' },
  { query: 'policy', want: 'RetryPolicy' },
  { query: 'entry', want: 'CacheEntry' },
  { query: 'bus', want: 'EventBus' },
  { query: 'config', want: 'HttpServerConfig' },
  { query: 'http', want: 'HttpServerConfig' },
  { query: 'session', want: 'SessionManager' },
  { query: 'auth', want: 'AuthService' },
  { query: 'retry', want: 'RetryPolicy' },
  { query: 'cache', want: 'CacheEntry' },
  { query: 'event', want: 'EventBus' },
  { query: 'drain', want: 'drain_queue' },
  { query: 'outbox worker please', want: 'OutboxWorker' },
  { query: 'the worker', want: 'OutboxWorker' },
  { query: 'a session manager', want: 'SessionManager' },
];

const negatives = ['please review this', 'the quick brown fox', 'and then we should', 'fix the tests', 'no match here'];

function run(query: string) {
  const idx = loadPacked(buildPacked(names));
  const span = proseSpan(`${query} `, query.length);
  const words = span?.words ?? query.toLowerCase().split(/\s+/).filter(Boolean);
  const key = words.join(' ');
  const ids = idx.retrieve(key || wordKey(query), 96);
  return rankAliases(words, candidatesFrom(idx, ids));
}

test('prose fixture first row is right on ≥89% of 50 cases (E7)', () => {
  assert.ok(positives.length >= 50, `need ≥50 cases, got ${positives.length}`);
  let right = 0;
  for (const row of positives) {
    const ranked = run(row.query);
    if (ranked[0]?.name === row.want) right++;
  }
  const pct = right / positives.length;
  assert.ok(pct >= 0.89, `first-row ${right}/${positives.length} = ${(pct * 100).toFixed(1)}%`);
});

test('plain-English negatives and stopwords yield no row or ≤1% of 1000 spans', () => {
  for (const q of negatives) {
    assert.equal(run(q).length, 0, q);
  }
  const words = [
    'please',
    'review',
    'this',
    'change',
    'for',
    'bugs',
    'and',
    'then',
    'write',
    'tests',
    'about',
    'the',
    'quick',
    'brown',
    'fox',
    'jumps',
  ];
  let hits = 0;
  for (let i = 0; i < 1000; i++) {
    const q = `${words[i % words.length]} ${words[(i + 3) % words.length]} ${words[(i + 7) % words.length]}`;
    if (run(q).length) hits++;
  }
  assert.ok(hits / 1000 <= 0.01, `negative hit rate ${hits}/1000`);
});

test('query p99 stays inside the 1.8 ms names budget on the fixture index (E8)', () => {
  const idx = loadPacked(buildPacked(names));
  const samples: number[] = [];
  for (let i = 0; i < 400; i++) {
    const q = positives[i % positives.length]?.query ?? 'outbox worker';
    const t0 = performance.now();
    const span = proseSpan(`${q} `, q.length);
    const words = span?.words ?? [];
    rankAliases(words, candidatesFrom(idx, idx.retrieve(words.join(' '), 96)));
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p99 = samples[Math.floor(samples.length * 0.99)] ?? 0;
  assert.ok(p99 <= 1.8, `p99 ${p99.toFixed(3)} ms`);
});

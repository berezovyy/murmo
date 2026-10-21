// Policy cost on the key: a single-boundary plan must stay under the r13
// budget, and a 1.1M-character prefix must not stall typing (E8).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WordPolicyQuery } from '@murmo/core';
import { encodeTable, lookup, mapTable } from '@murmo/lang';
import { createEnglishPolicy } from '../src/policy.ts';

const table = mapTable(encodeTable([['teh', 'the']]));
const policy = createEnglishPolicy();

function query(text: string): WordPolicyQuery {
  return {
    text,
    cursor: text.length,
    typed: ' ',
    rejected: new Set(),
    vocabulary: new Set(),
    lookup: (word) => lookup(table, word) ?? null,
  };
}

function p99(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1);
  return sorted[i] as number;
}

test('full single-boundary propose p99 is well under 40 µs in Node (r13 POLICY.md)', () => {
  const text = 'Please fix teh';
  policy.propose(query(text));
  const samples: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const t0 = performance.now();
    policy.propose(query(text));
    samples.push((performance.now() - t0) * 1000);
  }
  const ns = p99(samples);
  assert.ok(ns <= 40, `p99 ${ns.toFixed(1)} µs exceeds 40 µs`);
});

test('a 1.1M-character prefix stays under 6 ms per boundary (round-3 figure)', () => {
  const huge = `${'plain words '.repeat(100_000)}\nteh`;
  assert.ok(huge.length > 1_100_000);
  policy.propose(query(huge));
  const t0 = performance.now();
  const result = policy.propose(query(huge));
  const ms = performance.now() - t0;
  assert.equal(result?.insert, 'the');
  assert.ok(ms <= 6, `1.1M-character propose took ${ms.toFixed(2)} ms`);
});

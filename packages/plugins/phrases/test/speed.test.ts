// Prefix top-5 p99 ≤ 1 ms with 10k phrases (E2). Catches a lookup that costs a frame.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockPrefix, buildPacked, mapPacked } from '../src/packed.ts';

function p99(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)] as number;
}

test('prefix top-5 lookup p99 ≤ 1 ms with 10k phrases', () => {
  const rows = Array.from({ length: 10_000 }, (_, i) => {
    const a = ['cache', 'worker', 'client', 'server'][i % 4];
    const b = ['module', 'path', 'pool', 'layer'][Math.floor(i / 4) % 4];
    return { key: `update the ${a} ${b} ${i}`, value: String(i), score: i % 50 };
  });
  const index = mapPacked(buildPacked(rows));
  assert.ok(index);
  const prefixes = ['update the', 'update the c', 'update the w', 'add ', 'zzz'];
  for (let i = 0; i < 50; i++) blockPrefix(index, prefixes[i % prefixes.length] as string);
  const samples: number[] = [];
  for (let i = 0; i < 400; i++) {
    const q = prefixes[i % prefixes.length] as string;
    const t = performance.now();
    blockPrefix(index, q);
    samples.push(performance.now() - t);
  }
  assert.ok(p99(samples) <= 1, `p99 ${p99(samples).toFixed(3)} ms`);
});

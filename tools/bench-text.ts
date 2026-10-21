// Micro-benchmarks for the phase 04 cost targets (docs/plan/04 § Tests and
// acceptance, "Cost"), written to .runs/text-provenance-cost/<attempt>/:
//
//   - offset index for a 64 KiB draft (32,768 UTF-16 units): under 1 ms on Node;
//   - grapheme boundary check on ASCII: under 1 µs;
//   - typed-span update per typed character: at most 2 µs p99;
//   - typed-only projection of a 50 KiB draft: at most 0.5 ms.
//
//   node tools/bench-text.ts        exits 1 if a target is missed
//
// Single calls this fast are below the timer's resolution, so per-character
// costs are timed in batches of 100 and divided. The whole core costs about
// 10 µs per key today (lesson 45), and the guest snapshot copy about 6 ms per
// change (lesson 73), which is what these targets are sized against.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Draft } from '../packages/api/src/index.ts';
import { nextDraft, projectTyped, type TypingRules } from '../packages/provenance/src/index.ts';
import { isGraphemeBoundary, offsetIndex } from '../packages/text/src/index.ts';
import { newRun } from './runs.mjs';

interface Row {
  name: string;
  unit: 'ms' | 'us';
  p50: number;
  p99: number;
  target: number;
  /** Which statistic the target bounds. */
  bound: 'p50' | 'p99';
  ok: boolean;
}

function quantiles(samples: number[]): { p50: number; p99: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? Number.NaN;
  return { p50: at(0.5), p99: at(0.99) };
}

function measure(runs: number, batch: number, fn: () => void): number[] {
  for (let i = 0; i < Math.min(runs, 50) * batch; i++) fn(); // warm up the JIT
  const samples: number[] = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    for (let i = 0; i < batch; i++) fn();
    samples.push((performance.now() - start) / batch);
  }
  return samples;
}

const rows: Row[] = [];
function record(name: string, unit: Row['unit'], samples: number[], target: number, bound: Row['bound']): void {
  const scale = unit === 'us' ? 1000 : 1;
  const { p50, p99 } = quantiles(samples.map((ms) => ms * scale));
  const value = bound === 'p50' ? p50 : p99;
  rows.push({ name, unit, p50, p99, target, bound, ok: value <= target });
}

// A 64 KiB mixed draft: prose with emoji, ZWJ sequences, flags, accents and CJK
// in every line, so the segmenter runs on a large share of it.
const mixedPiece =
  'Ship it \u{1F680} — caf\u{E9} e\u{301} 日本語 \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} \u{1F1FA}\u{1F1E6} ok\n';
const mixed = mixedPiece.repeat(Math.ceil(32_768 / mixedPiece.length)).slice(0, 32_768);
record(
  'offsetIndex, 64 KiB mixed draft',
  'ms',
  measure(200, 1, () => offsetIndex(mixed)),
  1,
  'p50',
);
const emojiPiece = '\u{1F600}\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{1F1FA}\u{1F1E6}字';
const emoji = emojiPiece.repeat(Math.ceil(32_768 / emojiPiece.length)).slice(0, 32_766);
record(
  'offsetIndex, 64 KiB emoji/CJK only (worst case)',
  'ms',
  measure(100, 1, () => offsetIndex(emoji)),
  1,
  'p50',
);

const ascii = 'the quick brown fox jumps over the lazy dog '.repeat(1500);
let at = 0;
record(
  'isGraphemeBoundary, ASCII',
  'us',
  measure(2000, 1000, () => {
    at = (at + 7919) % ascii.length;
    isGraphemeBoundary(ascii, at);
  }),
  1,
  'p99',
);

// A 50 KiB draft that alternates typed words and pastes: 400 typed spans.
const rules: TypingRules = { evidence: 'host-labeled', keyBursts: false };
const spans: [number, number][] = [];
for (let from = 0; from + 40 <= 51_200; from += 128) spans.push([from, from + 40]);
const big: Draft = {
  text: 'x'.repeat(51_200),
  cursor: 51_200,
  version: 1,
  certainty: 'authoritative',
  typedSpans: spans,
};
record(
  'projectTyped, 50 KiB draft, 400 spans',
  'ms',
  measure(300, 1, () => projectTyped(big, 'host-labeled')),
  0.5,
  'p50',
);

// Typing at the end of a draft with 20 spans: the common case (append to the last span).
const typingSpans: [number, number][] = Array.from({ length: 20 }, (_, i) => [i * 100, i * 100 + 60]);
let typing: Draft = {
  text: 'y'.repeat(1960),
  cursor: 1960,
  version: 1,
  certainty: 'authoritative',
  typedSpans: typingSpans,
};
typing = { ...typing, typedSpans: [...typingSpans.slice(0, -1), [1900, 1960]] };
const start = typing;
let keys = 0;
record(
  'nextDraft, one typed character (20 spans)',
  'us',
  measure(5000, 100, () => {
    if (++keys % 2000 === 0) typing = start;
    typing = nextDraft(
      typing,
      { origin: 'typed', from: typing.text.length, to: typing.text.length, insert: 'a' },
      rules,
    );
  }),
  2,
  'p99',
);

const dir = newRun('text-provenance-cost');
const result = {
  runtime: `node ${process.version}`,
  date: new Date().toISOString(),
  rows,
};
writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
for (const r of rows) {
  const value = (n: number) => `${n.toFixed(3)} ${r.unit}`;
  console.log(
    `${r.ok ? 'ok  ' : 'MISS'} ${r.name.padEnd(48)} p50 ${value(r.p50).padStart(11)}  p99 ${value(r.p99).padStart(11)}  target ${r.bound} <= ${r.target} ${r.unit}`,
  );
}
console.log(`written to ${dir}`);
process.exitCode = rows.every((r) => r.ok) ? 0 : 1;

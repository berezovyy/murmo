// The generators must replay the round 13–14 numbers from the seed alone, or
// failing seeds cannot be replayed and the fuzz counts mean nothing (E8).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { GeneratorFile } from '../format.ts';
import { Sha256, sha256, summarize, unicode } from '../generators/index.ts';

const reference = (file: string): GeneratorFile =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

test('burst seed 1306637 reproduces the r13/r14 per-cohort counts over 10,000 streams', () => {
  const burst = reference('generators/burst.json');
  assert.ok(burst.reference);
  const { counts } = summarize('burst', burst.seed, burst.reference.size);
  assert.deepEqual(counts, burst.reference.counts);
  assert.equal(counts.keys, 189268);
  assert.equal(counts.corrections, 12489);
  assert.equal(counts.undoChecks, 9658);
  assert.equal(counts.ledgerChecks, 68936);
});

test('the portable SHA-256 matches node:crypto for non-BMP text and across chunk boundaries', () => {
  const samples = ['', 'abc', 'Ship it \u{1F680} — café 日本語', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000)];
  for (const s of samples)
    assert.equal(sha256(s), createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s.slice(0, 20)));
  const streamed = new Sha256();
  const node = createHash('sha256');
  for (let i = 0; i < 300; i++) {
    const part = `${i}\u{1F468}\u{200D}\u{1F469}`.repeat(i % 7);
    streamed.update(part);
    node.update(part, 'utf8');
  }
  assert.equal(streamed.digest(), node.digest('hex'));
});

test('shrinking proposes only smaller unicode specs, so a shrink loop always ends', () => {
  const [first] = unicode.generate(0x7c0de, 1);
  assert.ok(first);
  const size = (s: typeof first.spec) => s.chunks.length + s.cursors.length + (s.suffix ? 1 : 0);
  for (const candidate of unicode.shrink(first.spec)) assert.ok(size(candidate) < size(first.spec));
});

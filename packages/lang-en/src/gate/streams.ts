// The evaluation sets (docs/plan/12, "Evaluation gate"), all under
// fixtures/lang-en/ (moved byte for byte from the experiments; see moved.json):
//
// - clean-400k-counts.json: round 7's 400,000 seed-7004 draws from the round-6 corpus of
//   real Markdown prose, as word → count. A key that is a word here is a wrong
//   fix of clean text.
// - fast-typing-events-8004.jsonl: round 8's held-out slips (51,076 changed
//   words) from a timing and hand model unlike the generator's one-edit model.
// - test-counts.json: the round-6 corpus test split as word → count, from
//   which the seed-6002 stream (400,000 one-edit slips) is regenerated here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neighborsOf } from '../keyboard.ts';
import { PythonRandom } from './python-random.ts';

export const fixturesDir = fileURLToPath(new URL('../../../../fixtures/lang-en/', import.meta.url));

export interface Slip {
  /** The word the typist meant. */
  readonly intended: string;
  /** What reached the prompt. */
  readonly typed: string;
}

export type R6Op = 'swap' | 'drop' | 'double' | 'nearby';

/**
 * Round 6's `samples(test_counts, 6002, 100000)` (experiments/typo-list/analyze.py):
 * draw words by corpus frequency from those that are 3+ lowercase letters and
 * in the dictionary, then make one swap (when the word has two different
 * neighbors), one drop, one double and one nearby-key slip of each.
 *
 * Round 6 also excluded words that are keys of the typos list (CC BY-SA, so
 * not in this repo). No word of this pool is one, so the stream is identical
 * without it; the test pins the stream's SHA-256 to round 6's.
 */
export function r6SlipStream(
  counts: Readonly<Record<string, number>>,
  dictionary: ReadonlySet<string>,
  seed: number,
  draws: number,
): { op: R6Op; slip: Slip }[] {
  const rng = new PythonRandom(seed);
  const eligible = Object.keys(counts)
    .filter((w) => /^[a-z]{3,}$/.test(w) && dictionary.has(w))
    .sort();
  const words = rng.choices(
    eligible,
    eligible.map((w) => counts[w] as number),
    draws,
  );
  const out: { op: R6Op; slip: Slip }[] = [];
  const push = (op: R6Op, intended: string, typed: string) => out.push({ op, slip: { intended, typed } });
  for (const w of words) {
    const swaps: number[] = [];
    for (let i = 0; i < w.length - 1; i++) if (w[i] !== w[i + 1]) swaps.push(i);
    if (swaps.length) {
      const i = rng.choice(swaps);
      push('swap', w, w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
    }
    let i = rng.randrange(w.length);
    push('drop', w, w.slice(0, i) + w.slice(i + 1));
    i = rng.randrange(w.length);
    push('double', w, w.slice(0, i) + w[i] + w.slice(i));
    i = rng.randrange(w.length);
    push('nearby', w, w.slice(0, i) + rng.choice(neighborsOf(w[i] as string)) + w.slice(i + 1));
  }
  return out;
}

export function readCounts(file: string, dir = fixturesDir): Record<string, number> {
  return JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, number>;
}

/** Round 8's fast-typing events: one `{"source", "typed"}` object per line. */
export function readFastTyping(file = 'fast-typing-events-8004.jsonl', dir = fixturesDir): Slip[] {
  return readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const { source, typed } = JSON.parse(line) as { source: string; typed: string };
      return { intended: source, typed };
    });
}

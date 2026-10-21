import type { EditorCase, PureCase } from '../format.ts';

/** One generated stream: its semantic spec, the case the oracle derives from it, and its counters. */
export interface Generated<Spec, C extends EditorCase | PureCase> {
  index: number;
  spec: Spec;
  case: C;
  counts: Record<string, number>;
}

/**
 * A seeded generator. `generate` draws from xorshift32 in a fixed order, so a
 * seed replays the same streams everywhere. `build` is the oracle: it derives
 * steps and expectations from the spec alone, never from the code under test.
 * `shrink` proposes smaller specs, so a failing stream can be cut down to the
 * shortest one that still fails and saved as a fixed case.
 */
export interface Generator<Spec, C extends EditorCase | PureCase> {
  name: string;
  generate(seed: number, size: number): Iterable<Generated<Spec, C>>;
  build(spec: Spec, id: string): C;
  count(spec: Spec): Record<string, number>;
  shrink(spec: Spec): Iterable<Spec>;
}

export function addCounts(total: Record<string, number>, counts: Record<string, number>): void {
  for (const [key, value] of Object.entries(counts)) total[key] = (total[key] ?? 0) + value;
}

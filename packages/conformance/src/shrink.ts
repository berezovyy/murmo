// Seed shrinking: a failing generated stream is cut down, spec by spec, to the
// smallest one that still fails, then saved as a fixed case in the owning
// folder (docs/plan/02 § Generators). Shrinking works on the generator's
// spec, not on raw steps, so every candidate gets fresh expectations from the
// oracle instead of a half-edited step list with stale ones.

import type { EditorCase, PureCase } from '@murmo/fixtures';
import type { Generator } from '@murmo/fixtures/generators';

export interface Shrunk<Spec> {
  spec: Spec;
  case: EditorCase | PureCase;
  /** Candidates tried. */
  attempts: number;
}

/**
 * Greedy shrink: take the first smaller candidate that still fails, and start
 * over from it, until no candidate fails. `fails` runs one case on the subject.
 */
export async function shrinkFailure<Spec>(
  generator: Generator<Spec, EditorCase | PureCase>,
  spec: Spec,
  id: string,
  fails: (c: EditorCase | PureCase) => Promise<boolean>,
  maxAttempts = 2000,
): Promise<Shrunk<Spec>> {
  let current = spec;
  let attempts = 0;
  for (let progress = true; progress && attempts < maxAttempts; ) {
    progress = false;
    for (const candidate of generator.shrink(current)) {
      if (++attempts > maxAttempts) break;
      if (await fails(generator.build(candidate, id))) {
        current = candidate;
        progress = true;
        break;
      }
    }
  }
  return { spec: current, case: generator.build(current, id), attempts };
}

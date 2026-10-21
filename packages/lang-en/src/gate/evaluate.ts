// Scores a built table against the evaluation sets. Lookups go through the
// runtime reader on the packed bytes, so the gate measures the artifact that
// ships, not a JS map the build happened to hold.

import { lookup, type PackedTable } from '@murmo/lang';
import type { Slip } from './streams.ts';

export interface WrongFix {
  readonly typed: string;
  readonly fix: string;
  readonly intended: string;
  readonly count: number;
}

export interface SlipScore {
  readonly events: number;
  /** Fixed to the intended word. */
  readonly correct: number;
  /** Changed to a different word than intended. */
  readonly wrong: number;
  /** correct + wrong: every change the table would make. */
  readonly applied: number;
  readonly wrongExamples: readonly WrongFix[];
}

export interface CleanScore {
  readonly tokens: number;
  /** Clean-text tokens the table would change: each one is a wrong fix. */
  readonly wrong: number;
  readonly examples: readonly { readonly word: string; readonly count: number; readonly fix: string }[];
}

export function scoreSlips(table: PackedTable, slips: Iterable<Slip>, examples = 30): SlipScore {
  let events = 0;
  let correct = 0;
  let wrong = 0;
  const wrongs = new Map<string, WrongFix>();
  for (const { intended, typed } of slips) {
    events++;
    const fix = lookup(table, typed);
    if (fix === undefined) continue;
    if (fix === intended) {
      correct++;
      continue;
    }
    wrong++;
    const id = `${typed}\0${fix}\0${intended}`;
    const known = wrongs.get(id);
    wrongs.set(id, { typed, fix, intended, count: (known?.count ?? 0) + 1 });
  }
  const wrongExamples = [...wrongs.values()]
    .sort((a, b) => b.count - a.count || (a.typed < b.typed ? -1 : a.typed > b.typed ? 1 : 0))
    .slice(0, examples);
  return { events, correct, wrong, applied: correct + wrong, wrongExamples };
}

export function scoreClean(table: PackedTable, counts: Readonly<Record<string, number>>): CleanScore {
  let tokens = 0;
  let wrong = 0;
  const examples: { word: string; count: number; fix: string }[] = [];
  for (const [word, count] of Object.entries(counts)) {
    tokens += count;
    const fix = lookup(table, word);
    // The corpus counts are case-folded (`I` is counted as `i`), so a fix that
    // only restores case (i → I) is not a change to clean text.
    if (fix === undefined || fix.toLowerCase() === word) continue;
    wrong += count;
    examples.push({ word, count, fix });
  }
  return { tokens, wrong, examples };
}

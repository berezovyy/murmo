// The word sets every later step filters with, built from the pinned inputs
// exactly as round 7's prepare.py built them (r7 E2): correction targets from
// SCOWL levels 10–20, the real-word guard, the reverse-ambiguity guard with
// SCOWL levels, and the protected terms. Only `targets` can supply a
// correction; every other set only removes candidates.

import type { Inputs } from './inputs.ts';

export interface Target {
  /** Lowest SCOWL level the word appears at (10 or 20). */
  readonly level: number;
  /** The SCOWL `final/` list and 1-based line it was taken from, at that level. */
  readonly file: string;
  readonly line: number;
}

export interface Lexicon {
  readonly targets: ReadonlyMap<string, Target>;
  /** Word → SCOWL level, for words at levels ≤ 80 and protected terms (as level 35). */
  readonly guard: ReadonlyMap<string, number>;
  /** Every lowercase ASCII word in any SCOWL list or the system dictionary: a key that is one is dropped. */
  readonly realWords: ReadonlySet<string>;
  /** SCOWL abbreviations, project terms and programming terms: a key that is one is dropped. */
  readonly protectedTerms: ReadonlySet<string>;
}

export const TARGET_MAX_LEVEL = 20;
export const GUARD_MAX_LEVEL = 80;
/** Protected terms count as possible intended words in reverse ambiguity, as common as SCOWL level 35. */
export const PROTECTED_GUARD_LEVEL = 35;

const lowercaseWord = /^[a-z]+$/;
const asciiWord = /^[A-Za-z]+$/;
const guardWord = /^[a-z]{3,20}$/;

export function buildLexicon(inputs: Inputs): Lexicon {
  const targets = new Map<string, Target>();
  const guard = new Map<string, number>();
  const realWords = new Set<string>();
  const abbreviations = new Set<string>();

  // Sorted file order decides which file a target's provenance names when it
  // appears in several lists at the same level (american-words before english-words).
  for (const name of [...inputs.scowlLists.keys()].sort()) {
    const m = /^(.+)\.(\d+)$/.exec(name);
    if (!m) continue;
    const level = Number(m[2]);
    const correctionList = name.startsWith('english-words.') || name.startsWith('american-words.');
    const isAbbreviations = name.includes('abbreviations');
    const words = inputs.scowlLists.get(name) as readonly string[];
    for (let i = 0; i < words.length; i++) {
      const word = words[i] as string;
      const lower = word.toLowerCase();
      if (lowercaseWord.test(lower)) {
        realWords.add(lower);
        if (isAbbreviations) abbreviations.add(lower);
      }
      if (!correctionList || !guardWord.test(word)) continue;
      if (level <= GUARD_MAX_LEVEL) guard.set(word, Math.min(level, guard.get(word) ?? 100));
      if (level <= TARGET_MAX_LEVEL) {
        const known = targets.get(word);
        if (!known || level < known.level) targets.set(word, { level, file: name, line: i + 1 });
      }
    }
  }

  // The system dictionary only removes keys (r7: "negative membership filter only").
  for (const word of inputs.web2) if (asciiWord.test(word)) realWords.add(word.toLowerCase());

  const protectedTerms = new Set<string>(abbreviations);
  for (const term of inputs.projectTerms) protectedTerms.add(term);
  for (const term of inputs.programmingTerms) protectedTerms.add(term);
  for (const term of protectedTerms) {
    if (guardWord.test(term)) guard.set(term, Math.min(PROTECTED_GUARD_LEVEL, guard.get(term) ?? 100));
  }
  return { targets, guard, realWords, protectedTerms };
}

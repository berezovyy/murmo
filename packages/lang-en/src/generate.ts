// The generated base list: one keyboard slip of each SCOWL target, kept only
// when no filter objects (round 7's generate.py, strict level; r7 E2). Reads
// no typo list: every correction is a SCOWL word.
//
//   1. Generate slips: transposition, omission, doubled key, neighbor
//      substitution, neighbor insertion before or after a letter.
//   2. Drop keys under 3 letters, vetoed by hand, real words, protected terms,
//      and keys two different targets generate.
//   3. Drop keys under the policy's minimum length (strict: 5) and keys one
//      edit from a different guard word up to the policy's level (strict: 80).
//   4. Rank by target level, slip kind, target length, target, key; keep
//      entries until the packed table would pass the byte cap (2 MiB).

import { neighborsOf } from './keyboard.ts';
import type { Lexicon, Target } from './lexicon.ts';
import { type BasePolicy, STRICT } from './policy.ts';

export type Slip =
  | 'transpose'
  | 'omit'
  | 'double-phone-tap'
  | 'qwerty-substitute'
  | 'adjacent-phone-insert-before'
  | 'adjacent-phone-insert-after';

/** Ranking order of slip kinds: the more common slip wins a place under the cap. */
const slipRank: Readonly<Record<Slip, number>> = {
  transpose: 0,
  omit: 1,
  'double-phone-tap': 2,
  'qwerty-substitute': 3,
  'adjacent-phone-insert-before': 4,
  'adjacent-phone-insert-after': 4,
};

export interface BaseEntry {
  readonly key: string;
  readonly value: string;
  readonly slip: Slip;
  readonly target: Target;
}

export type DropReason =
  | 'shorter_than_3'
  | 'manual_review_reject'
  | 'real_word'
  | 'protected_identifier_extension_abbreviation'
  | 'multiple_generated_targets'
  | 'policy_min_length'
  | 'reverse_ambiguity'
  | 'byte_cap';

export interface BaseResult {
  readonly entries: readonly BaseEntry[];
  readonly generatedPaths: number;
  readonly candidates: number;
  readonly beforeByteCap: number;
  readonly dropped: Readonly<Record<DropReason, number>>;
}

/** Every slip of `word`, in round 7's order (the first path to a key decides its slip kind). */
export function* slips(word: string): Generator<[string, Slip]> {
  for (let i = 0; i < word.length - 1; i++) {
    if (word[i] !== word[i + 1]) yield [word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2), 'transpose'];
  }
  for (let i = 0; i < word.length; i++) {
    const c = word[i] as string;
    yield [word.slice(0, i) + word.slice(i + 1), 'omit'];
    yield [word.slice(0, i) + c + word.slice(i), 'double-phone-tap'];
    for (const d of neighborsOf(c)) {
      yield [word.slice(0, i) + d + word.slice(i + 1), 'qwerty-substitute'];
      yield [word.slice(0, i) + d + word.slice(i), 'adjacent-phone-insert-before'];
      yield [word.slice(0, i + 1) + d + word.slice(i + 1), 'adjacent-phone-insert-after'];
    }
  }
}

/**
 * Deletion signatures of the guard words: for each word, every string one
 * deletion away. Retrieves every guard word at Damerau distance one from a key
 * with a few map reads instead of generating all ~54·len neighbors.
 */
class GuardIndex {
  private readonly bySignature = new Map<string, string | string[]>();
  private readonly guard: ReadonlyMap<string, number>;
  constructor(guard: ReadonlyMap<string, number>) {
    this.guard = guard;
    for (const word of guard.keys()) {
      const seen = new Set<string>();
      for (let i = 0; i < word.length; i++) {
        const d = word.slice(0, i) + word.slice(i + 1);
        if (seen.has(d)) continue;
        seen.add(d);
        const old = this.bySignature.get(d);
        if (old === undefined) this.bySignature.set(d, word);
        else if (typeof old === 'string') this.bySignature.set(d, [old, word]);
        else old.push(word);
      }
    }
  }

  get size(): number {
    return this.bySignature.size;
  }

  /** Is a guard word other than `target`, at level ≤ `maxLevel`, one edit from `key`? */
  hasCompetitor(key: string, target: string, maxLevel: number): boolean {
    const competes = (w: string) => w !== target && (this.guard.get(w) as number) <= maxLevel;
    // Insertions: key is a guard word with one letter deleted.
    if (this.anyIn(key, competes)) return true;
    for (let i = 0; i < key.length; i++) {
      const d = key.slice(0, i) + key.slice(i + 1);
      // Deletions: key with one letter deleted is a guard word.
      if (this.guard.has(d) && competes(d)) return true;
      // Substitutions and transpositions share a deletion signature with the key.
      if (this.anyIn(d, (w) => w.length === key.length && oneApart(key, w) && competes(w))) return true;
    }
    for (let i = 0; i < key.length - 1; i++) {
      const t = key.slice(0, i) + key[i + 1] + key[i] + key.slice(i + 2);
      if (this.guard.has(t) && competes(t)) return true;
    }
    return false;
  }

  private anyIn(signature: string, test: (w: string) => boolean): boolean {
    const bucket = this.bySignature.get(signature);
    if (bucket === undefined) return false;
    if (typeof bucket === 'string') return test(bucket);
    return bucket.some(test);
  }
}

/** Same length, and one substitution or one adjacent transposition apart. */
function oneApart(a: string, b: string): boolean {
  let first = -1;
  let second = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (first < 0) first = i;
    else if (second < 0) second = i;
    else return false;
  }
  if (first >= 0 && second < 0) return true;
  return second === first + 1 && a[first] === b[second] && a[second] === b[first];
}

/** Packed bytes one entry adds: two u32 offsets plus its key and value. */
export const entryBytes = (key: string, value: string) => 8 + key.length + value.length;
/** Packed bytes of an empty table: the header plus the closing offset of each array. */
export const EMPTY_TABLE_BYTES = 40;

export function generateBase(lexicon: Lexicon, vetoes: ReadonlySet<string>, policy: BasePolicy = STRICT): BaseResult {
  const dropped: Record<DropReason, number> = {
    shorter_than_3: 0,
    manual_review_reject: 0,
    real_word: 0,
    protected_identifier_extension_abbreviation: 0,
    multiple_generated_targets: 0,
    policy_min_length: 0,
    reverse_ambiguity: 0,
    byte_cap: 0,
  };
  const order = [...lexicon.targets].sort(([a, ta], [b, tb]) => ta.level - tb.level || (a < b ? -1 : a > b ? 1 : 0));
  const candidates = new Map<string, { value: string; slip: Slip }>();
  const ambiguous = new Set<string>();
  let generatedPaths = 0;
  for (const [word] of order) {
    for (const [key, slip] of slips(word)) {
      generatedPaths++;
      if (key.length < policy.baseMinKeyLength) dropped.shorter_than_3++;
      else if (vetoes.has(key)) dropped.manual_review_reject++;
      else if (lexicon.realWords.has(key)) dropped.real_word++;
      else if (lexicon.protectedTerms.has(key)) dropped.protected_identifier_extension_abbreviation++;
      else if (!ambiguous.has(key)) {
        const old = candidates.get(key);
        if (!old) candidates.set(key, { value: word, slip });
        else if (old.value !== word) {
          ambiguous.add(key);
          candidates.delete(key);
          dropped.multiple_generated_targets++;
        }
      }
    }
  }

  const index = new GuardIndex(lexicon.guard);
  const kept: BaseEntry[] = [];
  for (const [key, { value, slip }] of candidates) {
    if (key.length < policy.minKeyLength) dropped.policy_min_length++;
    else if (index.hasCompetitor(key, value, policy.maxCompetitorLevel)) dropped.reverse_ambiguity++;
    else kept.push({ key, value, slip, target: lexicon.targets.get(value) as Target });
  }

  kept.sort(
    (a, b) =>
      a.target.level - b.target.level ||
      slipRank[a.slip] - slipRank[b.slip] ||
      a.value.length - b.value.length ||
      compare(a.value, b.value) ||
      compare(a.key, b.key),
  );
  let size = EMPTY_TABLE_BYTES;
  let take = 0;
  for (; take < kept.length; take++) {
    const e = kept[take] as BaseEntry;
    const cost = entryBytes(e.key, e.value);
    if (size + cost > policy.byteCap) break;
    size += cost;
  }
  dropped.byte_cap = kept.length - take;
  const entries = kept.slice(0, take).sort((a, b) => compare(a.key, b.key));
  return { entries, generatedPaths, candidates: candidates.size, beforeByteCap: kept.length, dropped };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

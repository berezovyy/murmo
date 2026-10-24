// The hand-written common list (round 8's audit.py, r8 § 1). authored.txt is
// the author's frozen draft, one `typo correction category` per line; this
// keeps a line unless review rejected it. Kept lines are deliberate exceptions
// to the base list's filters (including its 5-letter minimum), but still never
// a valid word (SCOWL ≤ 80) or a protected term, except the lowercase-only keys
// whose SCOWL matches are names or abbreviations (`teh`, `adn`, `thier`). A
// correction may be several words (`alot` → `a lot`), each a known word.

import type { AuthoredReview } from './inputs.ts';
import type { Lexicon } from './lexicon.ts';

export const AUTHORED_CATEGORIES = ['transpose', 'misspelling', 'programming', 'phone'] as const;
export type AuthoredCategory = (typeof AUTHORED_CATEGORIES)[number];

export interface AuthoredEntry {
  readonly key: string;
  readonly value: string;
  readonly category: AuthoredCategory;
  /** 1-based line of authored.txt: the entry's provenance. */
  readonly line: number;
  /** `deliberate-exception` when another word is one edit from the key; `reviewed` otherwise. */
  readonly review: 'deliberate-exception' | 'reviewed';
}

export interface AuthoredRejection {
  readonly line: number;
  readonly key: string;
  readonly reason: string;
}

export interface AuthoredResult {
  readonly kept: readonly AuthoredEntry[];
  readonly rejected: readonly AuthoredRejection[];
  /** Lines repeating an earlier key; the first line wins. */
  readonly duplicates: readonly { readonly line: number; readonly key: string; readonly firstLine: number }[];
  readonly lines: number;
}

export class AuthoredError extends Error {
  constructor(line: number, message: string) {
    super(`authored.txt line ${line}: ${message}`);
    this.name = 'AuthoredError';
  }
}

const alphabet = 'abcdefghijklmnopqrstuvwxyz';

/** Does any guard word other than the key and its correction lie one edit from the key? */
function hasOtherNeighbor(key: string, value: string, guard: ReadonlyMap<string, number>): boolean {
  const other = (w: string) => w !== value && w !== key && guard.has(w);
  for (let i = 0; i <= key.length; i++) {
    for (const c of alphabet) if (other(key.slice(0, i) + c + key.slice(i))) return true;
  }
  for (let i = 0; i < key.length; i++) {
    if (other(key.slice(0, i) + key.slice(i + 1))) return true;
    for (const c of alphabet) if (other(key.slice(0, i) + c + key.slice(i + 1))) return true;
  }
  for (let i = 0; i < key.length - 1; i++) {
    if (other(key.slice(0, i) + key[i + 1] + key[i] + key.slice(i + 2))) return true;
  }
  return false;
}

export function reviewAuthored(
  authored: readonly string[],
  review: AuthoredReview,
  lexicon: Lexicon,
  lowercaseOnly: ReadonlySet<string>,
): AuthoredResult {
  const programmingTargets = new Set(review.programmingTargets);
  const kept: AuthoredEntry[] = [];
  const rejected: AuthoredRejection[] = [];
  const duplicates: { line: number; key: string; firstLine: number }[] = [];
  const firstLine = new Map<string, number>();
  for (const [i, text] of authored.entries()) {
    const line = i + 1;
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) throw new AuthoredError(line, 'expected `typo correction category`');
    const key = parts[0] as string;
    const category = parts[parts.length - 1] as AuthoredCategory;
    const value = parts.slice(1, -1).join(' ');
    if (!(AUTHORED_CATEGORIES as readonly string[]).includes(category)) {
      throw new AuthoredError(line, `unknown category "${category}"`);
    }
    const first = firstLine.get(key);
    if (first !== undefined) {
      duplicates.push({ line, key, firstLine: first });
      continue;
    }
    firstLine.set(key, line);
    const reject = (reason: string): void => {
      rejected.push({ line, key, reason });
    };
    const handReject = review.rejected[key];
    if (handReject !== undefined) {
      reject(handReject);
      continue;
    }
    if (!lowercaseOnly.has(key)) {
      if (lexicon.validWords.has(key)) {
        reject('real word: no automatic lexical normalization');
        continue;
      }
      if (lexicon.protectedTerms.has(key)) {
        reject('identifier, extension, abbreviation or project term');
        continue;
      }
      const known = value.split(' ').every((word) => lexicon.realWords.has(word.toLowerCase()));
      if (!known && !programmingTargets.has(value)) {
        reject('correction is not a known word; rejected rather than inventing one');
        continue;
      }
    }
    kept.push({
      key,
      value,
      category,
      line,
      review: hasOtherNeighbor(key, value, lexicon.guard) ? 'deliberate-exception' : 'reviewed',
    });
  }
  return { kept, rejected, duplicates, lines: authored.length };
}

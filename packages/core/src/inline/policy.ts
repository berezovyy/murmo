// Trusted word policies compiled into the core bundle. A rule set names one;
// no plugin function ever runs here. Phase 07 ships an exact-lookup stand-in
// under the production name so the interpreter and burst fuzz can land before
// phase 13 replaces it with the English skip/case rules.

export const ENGLISH_POLICY = 'english-word-boundary-v1';

export interface WordProposal {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface WordPolicyQuery {
  readonly text: string;
  readonly cursor: number;
  readonly typed: string;
  readonly rejected: ReadonlySet<string>;
  readonly vocabulary: ReadonlySet<string>;
  lookup(word: string): string | null;
}

export interface WordPolicy {
  readonly name: string;
  propose(query: WordPolicyQuery): WordProposal | null;
  /** Block shortcut expansion in code spans; the test policy never skips. */
  inCode(prefix: string): boolean;
}

const policies = new Map<string, WordPolicy>();

/** Phase 13 calls this with the real English policy of the same name. */
export function registerPolicy(policy: WordPolicy): void {
  policies.set(policy.name, policy);
}

export function policyByName(name: string): WordPolicy | undefined {
  return policies.get(name);
}

/**
 * Exact lookup, no case folding, no skip rules (docs/plan/07). The word is the
 * run of non-space before the cursor; `lookup` is the packed table plus any
 * inline overrides the rewriter installed.
 */
export const exactLookupPolicy: WordPolicy = {
  name: ENGLISH_POLICY,
  inCode() {
    return false;
  },
  propose(query) {
    if (!Number.isInteger(query.cursor) || query.cursor < 0 || query.cursor > query.text.length) return null;
    const raw = /\S+$/.exec(query.text.slice(0, query.cursor))?.[0];
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (query.rejected.has(lower) || query.vocabulary.has(lower)) return null;
    const insert = query.lookup(raw);
    if (!insert || insert === raw) return null;
    return { from: query.cursor - raw.length, to: query.cursor, insert };
  },
};

registerPolicy(exactLookupPolicy);

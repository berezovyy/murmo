// The one learning rule (docs/plan/13): a word rejected by immediate Backspace
// or Murmo's undo in two different drafts within 30 days joins the user
// allowlist that phase 19 stores. Off until 14's store and 19's list land;
// per-draft rejection in the core rewriter still works.

export const LEARN_ALLOWLIST = false;
export const LEARN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const LEARN_DRAFTS = 2;

export interface RejectionRecord {
  readonly word: string;
  readonly drafts: readonly string[];
  readonly lastMs: number;
}

/**
 * Records one per-draft rejection. Returns the word to add to the user
 * allowlist, or null. No-ops while `LEARN_ALLOWLIST` is false (phase 19).
 */
export function noteLearnedRejection(
  word: string,
  draftId: string,
  wallTimeMs: number,
  prior: readonly RejectionRecord[],
  privateMode: boolean,
): { readonly allow: string | null; readonly records: readonly RejectionRecord[] } {
  if (!LEARN_ALLOWLIST || privateMode) return { allow: null, records: prior };
  const lower = word.toLowerCase();
  const cutoff = wallTimeMs - LEARN_WINDOW_MS;
  const kept = prior.filter((r) => r.lastMs >= cutoff && r.word !== lower);
  const current = prior.find((r) => r.word === lower && r.lastMs >= cutoff);
  const drafts = current ? [...current.drafts] : [];
  if (!drafts.includes(draftId)) drafts.push(draftId);
  const records = [...kept, { word: lower, drafts, lastMs: wallTimeMs }];
  return { allow: drafts.length >= LEARN_DRAFTS ? lower : null, records };
}

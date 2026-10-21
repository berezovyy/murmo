// Backspace-rejection learning: two different drafts within 30 days add the
// word to the user allowlist (phase 13's rule). Private mode writes nothing.
// Status is shown once; `murmo words remove` undoes it.

import { LEARN_ALLOWLIST, noteLearnedRejection, type RejectionRecord } from '@murmo/plugin-autocorrect';
import type { Store } from '@murmo/store/node';
import { normalizeKey } from '../index.ts';

const REJECTIONS_KEY = 'rejections';

export function learnedStatus(word: string): string {
  return `Murmo will leave "${word}" alone from now on. murmo words remove ${word} to undo.`;
}

export interface LearnResult {
  readonly allow: string | null;
  readonly status: string | null;
  readonly records: readonly RejectionRecord[];
}

function parseRecords(value: unknown): RejectionRecord[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: RejectionRecord[] = [];
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue;
    const rec = row as { word?: unknown; drafts?: unknown; lastMs?: unknown };
    if (typeof rec.word !== 'string' || typeof rec.lastMs !== 'number' || !Array.isArray(rec.drafts)) continue;
    if (!rec.drafts.every((d) => typeof d === 'string')) continue;
    out.push({ word: rec.word, drafts: rec.drafts, lastMs: rec.lastMs });
  }
  return out;
}

async function loadRecords(store: Store): Promise<RejectionRecord[]> {
  const got = await store.plugins.forPlugin('autocorrect').get(REJECTIONS_KEY);
  if (got.status !== 'ok' || got.value === undefined) return [];
  return parseRecords(got.value);
}

async function saveRecords(store: Store, records: readonly RejectionRecord[]): Promise<void> {
  await store.plugins.forPlugin('autocorrect').set(REJECTIONS_KEY, records);
}

/**
 * Records one Backspace rejection. A word of two drafts is stored on the
 * allowlist.
 */
export async function learnRejection(
  store: Store,
  word: string,
  draftId: string,
  wallTimeMs: number,
): Promise<LearnResult> {
  const key = normalizeKey(word);
  if (!key || !LEARN_ALLOWLIST) return { allow: null, status: null, records: [] };
  const privateMode = await store.privacy.isPrivate();
  const prior = await loadRecords(store);
  const noted = noteLearnedRejection(key, draftId, wallTimeMs, prior, privateMode);
  if (noted.records !== prior) await saveRecords(store, noted.records);
  if (!noted.allow) return { allow: null, status: null, records: noted.records };
  const written = await store.words.add(noted.allow, { learned: true });
  if (written.status !== 'ok') return { allow: null, status: null, records: noted.records };
  return { allow: noted.allow, status: learnedStatus(noted.allow), records: noted.records };
}

export interface Learner {
  note(word: string): Promise<LearnResult>;
  endDraft(): void;
}

/** Session-facing learner: one draft id until `endDraft` (submit). */
export function createLearner(store: Store, now: () => number = () => Date.now()): Learner {
  let draft = 1;
  return {
    async note(word) {
      return learnRejection(store, word, `d${draft}`, now());
    },
    endDraft() {
      draft++;
    },
  };
}

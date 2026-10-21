// One registered rule set's interpreter: plan inside the native transaction,
// arm undo/pending-dot only on a matching applied commit, queue oversized
// shortcuts as deferred versioned edits.

import type { Change, KeyId } from '@murmo/api';
import type { InlineAnswer, InlineCommit, InlineReplay, InlineSnapshot } from '@murmo/api/adapter';
import { commitArms } from './commit.ts';
import { cloneState, type DeferredEdit, planWalk, replaceAnswer, type WalkState } from './interpreter.ts';
import type { RegisteredInline } from './registry.ts';

export interface InlineRewriter {
  readonly id: string;
  readonly owner: string;
  readonly priority: number;
  plan(snapshot: InlineSnapshot): InlineAnswer;
  commit(commit: InlineCommit): boolean;
  observe(change: Change): void;
  noteKey(key: KeyId): void;
  rejectWord(word: string): void;
  clear(): void;
  takeDeferred(): DeferredEdit[];
  lastCommitCount(): number;
  undoDepth(): number;
}

export function createInlineRewriter(rule: RegisteredInline, allowBackspace: boolean): InlineRewriter {
  const rejected = new Set<string>();
  let current: WalkState | null = null;
  let version = -1;
  let awaiting: {
    id: string;
    state: WalkState;
    replay: InlineReplay;
    deferred: DeferredEdit[];
    rejected?: string;
  } | null = null;
  let readyDeferred: DeferredEdit[] = [];
  let lastCommitCount = 0;

  const clear = () => {
    current = null;
    version = -1;
    awaiting = null;
    readyDeferred = [];
    rejected.clear();
  };

  return {
    id: rule.id,
    owner: rule.owner,
    priority: rule.priority,

    plan(snapshot) {
      awaiting = null;
      readyDeferred = [];
      if (!rule.enabled) return { action: 'native' };
      const prior = current && version === snapshot.version ? current : null;
      const result = planWalk(rule, snapshot, prior, rejected, allowBackspace);
      if ('action' in result) return result;
      const { state, replay, corrections, deferred, rejected: rejectedWord } = result;
      awaiting = {
        id: snapshot.transactionId,
        state,
        replay,
        deferred,
        ...(rejectedWord ? { rejected: rejectedWord } : {}),
      };
      if (!corrections.length) return { action: 'native', replay };
      return replaceAnswer(rule.owner, rule.id, state, replay);
    },

    commit(c) {
      lastCommitCount = 0;
      const a = awaiting;
      if (!a || a.id !== c.transactionId) return false;
      awaiting = null;
      if (!commitArms({ id: a.id, text: a.state.text, cursor: a.state.cursor, replay: a.replay }, c)) {
        current = null;
        readyDeferred = [];
        return false;
      }
      lastCommitCount = a.replay.corrections.filter((x) => x.kind !== 'undo').length;
      current = cloneState(a.state);
      version = c.version;
      readyDeferred = a.deferred;
      if (a.rejected) rejected.add(a.rejected);
      return a.replay.corrections.length > 0;
    },

    observe(change) {
      if (!change.draft.text) {
        clear();
        return;
      }
      if (awaiting && change.draft.text === awaiting.state.text && change.draft.cursor === awaiting.state.cursor)
        return;
      if (
        current &&
        (change.draft.version !== version ||
          change.draft.text !== current.text ||
          change.draft.cursor !== current.cursor)
      ) {
        current = null;
      }
    },

    noteKey(key) {
      if (key !== 'Backspace' && current) current.immediate = false;
    },

    rejectWord(word) {
      rejected.add(word.toLowerCase());
    },

    clear,
    takeDeferred() {
      const edits = readyDeferred;
      readyDeferred = [];
      return edits;
    },
    lastCommitCount: () => lastCommitCount,
    undoDepth: () => current?.undo.length ?? 0,
  };
}

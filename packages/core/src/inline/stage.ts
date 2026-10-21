// Session-facing inline stage: cap checks, ordered rule sets, deferred large
// expansions. The adapter calls `plan` inside the native transaction; no
// executor, timer or host read runs here.

import type { Change, Edit, KeyId } from '@murmo/api';
import type { HostCapabilities, InlineAnswer, InlineCommit, InlineSnapshot } from '@murmo/api/adapter';
import { unsafeText } from '@murmo/text';
import type { RegisteredInline } from './registry.ts';
import { createInlineRewriter } from './rewriter.ts';

export interface DeferredRequest {
  readonly owner: string;
  readonly edit: Edit;
  readonly expected: string;
}

export interface InlineStage {
  plan(snapshot: InlineSnapshot): InlineAnswer;
  commit(commit: InlineCommit): { corrections: number; deferred: DeferredRequest[] };
  observe(change: Change): void;
  noteKey(key: KeyId): void;
  rejectWord(word: string): void;
  clear(): void;
  undoDepth(): number;
  /** Always 0: this path never calls an executor (lesson 46, E1). */
  executorCalls(): number;
}

export function createInlineStage(rules: readonly RegisteredInline[], caps: HostCapabilities): InlineStage {
  const allowBackspace = caps.inline.allKeysObserved && caps.inline.observedKeys.includes('Backspace');
  const ordered = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority)
    .map((r) => createInlineRewriter(r, allowBackspace));
  const live = () =>
    caps.inputOriginEvidence === 'host-labeled' &&
    caps.inlineRewrite !== 'unsupported' &&
    caps.inline.commitReceipt !== 'none' &&
    ordered.length > 0;

  const safe = (s: InlineSnapshot) =>
    s.state.mode === 'prose' &&
    s.state.editorMode === 'insert' &&
    !s.state.busy &&
    !s.state.dialog &&
    s.state.popup === null &&
    !s.state.history &&
    s.certainty !== 'unknown' &&
    (!s.selection || s.selection[0] === s.selection[1]) &&
    (caps.inline.middle || s.cursor === s.text.length);

  return {
    plan(snapshot) {
      if (!live()) return { action: 'native' };
      if (
        caps.inlineRewrite === 'next-key' &&
        !snapshot.deferred &&
        !['Undo', 'F6', 'Backspace'].includes(snapshot.key.id)
      ) {
        return { action: 'native' };
      }
      if (!safe(snapshot)) return { action: 'native' };
      let native: InlineAnswer = { action: 'native' };
      for (const interpreter of ordered) {
        const answer = interpreter.plan(snapshot);
        if (answer.action === 'native') native = answer;
        if (answer.action === 'replace') {
          if (unsafeText(answer.text) !== null) return { action: 'native' };
          if (!caps.inline.multiline && answer.text.includes('\n')) return { action: 'native' };
          return answer;
        }
      }
      return native;
    },

    commit(c) {
      let corrections = 0;
      const deferred: DeferredRequest[] = [];
      for (const interpreter of ordered) {
        interpreter.commit(c);
        corrections += interpreter.lastCommitCount();
        for (const request of interpreter.takeDeferred()) {
          deferred.push({
            owner: interpreter.owner,
            expected: request.expected,
            edit: {
              from: request.from,
              to: request.to,
              insert: request.insert,
              baseVersion: c.version,
              undoable: true,
              label: 'inline shortcut async fallback',
            },
          });
        }
      }
      deferred.sort((a, b) => b.edit.from - a.edit.from);
      return { corrections, deferred };
    },

    observe(change) {
      for (const interpreter of ordered) interpreter.observe(change);
    },

    noteKey(key) {
      for (const interpreter of ordered) interpreter.noteKey(key);
    },

    rejectWord(word) {
      for (const interpreter of ordered) interpreter.rejectWord(word);
    },

    clear() {
      for (const interpreter of ordered) interpreter.clear();
    },

    undoDepth() {
      return ordered.reduce((n, r) => n + r.undoDepth(), 0);
    },

    executorCalls: () => 0,
  };
}

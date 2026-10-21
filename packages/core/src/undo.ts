// Murmo's own one-step undo (lesson 36): if the very next key after a Murmo
// edit is Backspace or the host's undo key, the session reverses the edit
// itself; any other key, cursor move, paste or unknown change hands undo back
// to the host. Whole-buffer snapshot undo is an anti-pattern (knowledge § 3):
// a record restores exactly the draft before one edit, and only while the
// draft is still exactly the one that edit produced.

import type { Draft } from '@murmo/api';
import { splice } from '@murmo/provenance';

export interface UndoRecord {
  readonly before: Draft;
  /** The committed snapshot; the record is valid only while this is the current version. */
  readonly after: Draft;
  readonly owner: string;
  /** Autocorrect: an immediate Backspace also removes the typed separator after the edit. */
  readonly rejectSeparator: boolean;
}

/** Which gesture asked for the undo: Backspace may also drop the separator, the undo key never does. */
export type UndoGesture = 'backspace' | 'undo-key';

/**
 * The draft a record restores. With `rejectSeparator`, Backspace restores the
 * word and removes the space typed after it; the undo key restores the word
 * and keeps the space (02-architecture; shared-v2 api.md).
 */
export function restoreTarget(record: UndoRecord, gesture: UndoGesture): Draft {
  const before = record.before;
  const at = before.cursor;
  if (gesture !== 'backspace' || !record.rejectSeparator || at === 0 || before.text[at - 1] !== ' ') return before;
  const { selection: _dropped, ...rest } = before;
  return {
    ...rest,
    text: before.text.slice(0, at - 1) + before.text.slice(at),
    cursor: at - 1,
    typedSpans: splice(before.typedSpans, at - 1, at, 0, false),
  };
}

/** True when the draft equals the target in everything a restore must put back. */
export function restoredExactly(draft: Draft, target: Draft): boolean {
  const spans = (d: Draft) => JSON.stringify(d.typedSpans);
  const selection = (d: Draft) => (d.selection && d.selection[0] !== d.selection[1] ? `${d.selection}` : '');
  return (
    draft.text === target.text &&
    draft.cursor === target.cursor &&
    selection(draft) === selection(target) &&
    spans(draft) === spans(target)
  );
}

/** The records of consecutive Murmo edits, newest last; several restore in reverse order. */
export class UndoLog {
  #records: UndoRecord[] = [];

  get depth(): number {
    return this.#records.length;
  }

  top(): UndoRecord | undefined {
    return this.#records[this.#records.length - 1];
  }

  push(record: UndoRecord): void {
    this.#records.push(record);
  }

  /** The newest record, if the draft is still exactly the one its edit produced. */
  armed(draft: Draft): UndoRecord | undefined {
    const top = this.top();
    return top && top.after.version === draft.version ? top : undefined;
  }

  /** Takes the newest record off for a restore. */
  pop(): UndoRecord | undefined {
    return this.#records.pop();
  }

  /** Any change other than the newest record's own result ends the window. */
  observe(draft: Draft): void {
    if (this.#records.length && this.top()?.after.version !== draft.version) this.clear();
  }

  /**
   * After a restore applied, the previous record (an earlier edit in the same
   * run) becomes current again if the restored draft is exactly what that edit
   * produced: its versions are rebased onto the restore's snapshot.
   */
  rebase(target: Draft, restored: Draft): void {
    const previous = this.top();
    if (!previous) return;
    if (previous.after.text === target.text && previous.after.cursor === target.cursor) {
      this.#records[this.#records.length - 1] = { ...previous, after: restored };
    } else this.clear();
  }

  clear(): void {
    this.#records = [];
  }
}

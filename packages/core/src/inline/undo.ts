// Per-correction undo patches (lesson 67). One patch per applied proposal;
// later native ranges rebase through the same splice the text took. A patch
// whose range was overwritten is dropped.

import type { Range } from '@murmo/api';

export interface UndoPatch {
  from: number;
  insert: string;
  original: string;
  spans: Range[];
  reject: boolean;
  word: string;
}

/** Shift patches after a splice at `[from, to)` of `length` inserted units. */
export function rebasePatches(records: UndoPatch[], from: number, to: number, length: number): void {
  const delta = length - (to - from);
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record) continue;
    const end = record.from + record.insert.length;
    if (to <= record.from) record.from += delta;
    else if (from < end) records.splice(i, 1);
  }
}

export function rebaseDeferred<T extends { from: number; to: number }>(
  records: T[],
  from: number,
  to: number,
  length: number,
): void {
  const delta = length - (to - from);
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record) continue;
    if (to <= record.from) {
      record.from += delta;
      record.to += delta;
    } else if (from < record.to) records.splice(i, 1);
  }
}

/** Cursor after restoring `original` over `insert` at `from`, given the cursor before the restore. */
export function cursorAfterUndo(cursor: number, from: number, insert: string, original: string): number {
  if (cursor <= from) return cursor;
  if (cursor >= from + insert.length) return cursor + original.length - insert.length;
  return from + Math.min(cursor - from, original.length);
}

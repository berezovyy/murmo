// OpenTUI offsets are display cells (lesson 20). Convert against a fresh
// `plainText` via the host's `measureText` / `getTextRange` — never a guessed
// wcwidth (r10 O3: the family emoji is 8 cells on stock OpenCode).

import type { TextareaEditor } from './types.ts';

export function toCells(editor: TextareaEditor, text: string, utf16: number): number {
  return editor.editBuffer.measureText(text.slice(0, utf16));
}

export function fromCells(editor: TextareaEditor, cells: number): number {
  return editor.editBuffer.getTextRange(0, cells).length;
}

/** True when `index` is a grapheme-safe UTF-16 offset the host can round-trip. */
export function representable(editor: TextareaEditor, text: string, index: number): boolean {
  if (!Number.isInteger(index) || index < 0 || index > text.length) return false;
  return editor.editBuffer.getTextRange(0, toCells(editor, text, index)) === text.slice(0, index);
}

/**
 * OpenTUI `addHighlightByCharRange` wants per-line character offsets: cell
 * offset minus the row index (r10/r13 measured).
 */
export function toHighlightRange(
  editor: TextareaEditor,
  cellStart: number,
  cellEnd: number,
): { readonly start: number; readonly end: number } {
  const startRow = editor.editBuffer.offsetToPosition(cellStart).row;
  const endRow = editor.editBuffer.offsetToPosition(cellEnd).row;
  return { start: cellStart - startRow, end: cellEnd - endRow };
}

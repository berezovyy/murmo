// Prompt parts (file mentions, collapsed pastes) are real text under
// `virtual: true` extmarks. Edits must not cross them (knowledge § OpenCode).

import type { TextareaEditor } from './types.ts';

export function virtualMarks(editor: TextareaEditor): readonly { readonly start: number; readonly end: number }[] {
  try {
    return editor.extmarks.getAll().filter((mark) => mark.virtual);
  } catch {
    return [];
  }
}

export function hasOpaqueParts(editor: TextareaEditor): boolean {
  return virtualMarks(editor).length > 0;
}

/** Cell-range `[from, to)` may be a caret (`from === to`) or a replacement. */
export function rangeTouchesPart(editor: TextareaEditor, from: number, to: number): boolean {
  for (const mark of virtualMarks(editor)) {
    if (from === to) {
      if (from > mark.start && from < mark.end) return true;
    } else if (from < mark.end && to > mark.start) {
      return true;
    }
  }
  return false;
}

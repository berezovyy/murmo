// Code-like word detection for the `at-code-like-word` key condition
// (docs/plan/36, r9 matcher `codeLike`). The names plugin uses the same
// functions so Tab is consumed only where a project-name menu can apply.

const CODE_MARK = /`|_|::|\.|\(\)|\//;
const CAMEL = /[\p{Ll}\p{Lo}\p{M}\p{N}][\p{Lu}]|[\p{Lu}]{2,}[\p{Ll}]/u;

/** True when `token` looks like an identifier, path or qualified name, not prose. */
export function isCodeLike(token: string): boolean {
  return CODE_MARK.test(token) || CAMEL.test(token);
}

/**
 * The non-whitespace run touching the cursor from the left. Cursor must sit at
 * the end of that run (or at a following boundary): mid-word does not match.
 */
export function wordAtCursor(text: string, cursor: number): { start: number; end: number; word: string } {
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1] ?? '')) start--;
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end] ?? '')) end++;
  return { start, end, word: text.slice(start, end) };
}

/** Coordinator predicate: cursor is at the end of a code-like word. */
export function atCodeLikeWord(text: string, cursor: number): boolean {
  if (cursor < text.length && !/\s/.test(text[cursor] ?? '')) return false;
  const { word } = wordAtCursor(text, cursor);
  return word.length > 0 && isCodeLike(word);
}

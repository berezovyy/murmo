// Open/close rules for the `;` menu. The core's `at-word-start` claim is the
// same whitespace test; this walks the typed draft so pasted or recalled `;`
// never opens (docs/plan/16, lesson 32).

import type { Draft, HostState, Range } from '@murmo/api';

/** Same boundary set as shortcut Space expansion (`InlineRules.boundaries`). */
const BOUNDARY = /[\s.,;:!?]/;

export interface Trigger {
  readonly start: number;
  readonly query: string;
}

function typedCovers(spans: readonly Range[], from: number, to: number): boolean {
  if (!(from < to)) return false;
  return spans.some(([a, b]) => a <= from && b >= to);
}

/** True inside an unclosed ``` fence or an odd inline-backtick span (r9 backtick guard). */
export function inCode(prefix: string): boolean {
  let fence = false;
  let inline = false;
  for (let i = 0; i < prefix.length; ) {
    if (prefix.startsWith('```', i)) {
      fence = !fence;
      i += 3;
      continue;
    }
    if (!fence && prefix[i] === '`') inline = !inline;
    i++;
  }
  return fence || inline;
}

/** Line of `at` starts with a host command prefix (`/`, `@`, `!`), ignoring leading spaces. */
export function commandPrefix(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const first = text.slice(lineStart, at).trimStart()[0];
  return first === '/' || first === '@' || first === '!';
}

export function hostBlocksMenu(state: HostState): boolean {
  return (
    state.mode !== 'prose' ||
    state.editorMode !== 'insert' ||
    state.popup !== null ||
    state.dialog ||
    state.busy ||
    state.history
  );
}

/**
 * The typed `;query` before the cursor, or null. Query stops at a boundary;
 * the `;` itself must sit at a word start and be covered by typed spans.
 */
export function findTrigger(draft: Draft): Trigger | null {
  const { text, cursor, typedSpans } = draft;
  if (!Number.isInteger(cursor) || cursor < 1 || cursor > text.length) return null;
  let start = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ';') {
      start = i;
      break;
    }
    if (ch !== undefined && BOUNDARY.test(ch)) return null;
  }
  if (start < 0) return null;
  if (start > 0 && !/\s/.test(text[start - 1] ?? '')) return null;
  if (commandPrefix(text, start) || inCode(text.slice(0, start))) return null;
  if (!typedCovers(typedSpans, start, cursor)) return null;
  return { start, query: text.slice(start + 1, cursor) };
}

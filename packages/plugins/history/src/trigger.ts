// `;?query` at a typed word start. The shortcut finder treats `?` as a
// boundary, so history cannot reuse it.

import type { Draft, Range } from '@murmo/api';
import { commandPrefix, hostBlocksMenu, inCode } from '@murmo/plugin-shortcuts';

export interface HistoryTrigger {
  readonly start: number;
  readonly query: string;
}

function typedCovers(spans: readonly Range[], from: number, to: number): boolean {
  if (!(from < to)) return false;
  return spans.some(([a, b]) => a <= from && b >= to);
}

/**
 * The typed `;?query` before the cursor, or null. Query may contain spaces;
 * it stops at a newline.
 */
export function findHistoryTrigger(draft: Draft): HistoryTrigger | null {
  const { text, cursor, typedSpans } = draft;
  if (!Number.isInteger(cursor) || cursor < 2 || cursor > text.length) return null;
  let start = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    if (text.startsWith(';?', i)) {
      start = i;
      break;
    }
    if (text[i] === '\n') return null;
  }
  if (start < 0) return null;
  if (start > 0 && !/\s/.test(text[start - 1] ?? '')) return null;
  if (commandPrefix(text, start) || inCode(text.slice(0, start))) return null;
  if (!typedCovers(typedSpans, start, cursor)) return null;
  return { start, query: text.slice(start + 2, cursor) };
}

export { hostBlocksMenu };

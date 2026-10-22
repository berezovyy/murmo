// One sanitizer for display and insert (knowledge § 7, E10). Controls, bidi
// overrides and zero-width characters never reach the screen or the draft.

import { displayText, invisibleRuns } from '@murmo/text';

/** Strips invisible runs, then escapes leftover C0/C1, bidi and lone surrogates. */
export function sanitizeCandidate(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  const runs = invisibleRuns(text);
  let cleaned = '';
  let at = 0;
  for (const [from, to] of runs) {
    cleaned += text.slice(at, from);
    at = to;
  }
  cleaned += text.slice(at);
  return displayText(cleaned);
}

/** True when `text` still contains a C0/C1 control (other than none — all are escaped). */
export function hasRawControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return true;
  }
  return false;
}

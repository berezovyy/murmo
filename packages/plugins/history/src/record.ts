// What history may store: a whole typed prompt at a confirmed send, never a
// paste, rescue, extension, slash or shell (E8, E13, E14). It stores the text
// as typed: there is no secret detection.

import type { CommitLevel, Range, SubmitCommitted, SubmitGesture } from '@murmo/api';
import { utf8Length } from '@murmo/store';

export const MAX_TEXT_BYTES = 16 * 1024;

export type SkipReason =
  | 'disabled'
  | 'private'
  | 'no-typed-spans'
  | 'partial-typed'
  | 'unknown-certainty'
  | 'slash-command'
  | 'shell-mode'
  | 'inferred-queue'
  | 'bad-gesture'
  | 'empty'
  | 'too-large';

export interface RecordInput {
  readonly text: string;
  readonly typedSpans?: readonly Range[];
  readonly gesture: SubmitGesture;
  readonly level: CommitLevel;
  readonly certainty?: 'authoritative' | 'tracked' | 'unknown';
  readonly mode?: 'prose' | 'shell' | 'command' | 'unknown';
}

export interface RecordDecision {
  readonly store: boolean;
  readonly skip?: SkipReason;
}

/** Every UTF-16 unit in `[from, to)` sits inside some span. */
export function spansCover(spans: readonly Range[], from: number, to: number): boolean {
  if (from >= to) return true;
  if (spans.length === 0) return false;
  let at = from;
  const ordered = spans.length > 1 ? [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]) : spans;
  for (const [start, end] of ordered) {
    if (end <= at) continue;
    if (start > at) return false;
    at = end;
    if (at >= to) return true;
  }
  return at >= to;
}

function startsWithCommand(text: string): boolean {
  const trimmed = text.replace(/^[ \t]+/, '');
  return trimmed.startsWith('/') || trimmed.startsWith('!');
}

function whitespaceOnly(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Policy for one `onSubmitCommitted` event. Whole-text typed, observed (or
 * inferred send), 16 KiB cap.
 */
export function decideRecord(input: RecordInput): RecordDecision {
  if (input.gesture !== 'send' && input.gesture !== 'queue' && input.gesture !== 'steer') {
    return { store: false, skip: 'bad-gesture' };
  }
  if (input.level === 'inferred' && input.gesture !== 'send') {
    return { store: false, skip: 'inferred-queue' };
  }
  if (input.certainty === 'unknown') return { store: false, skip: 'unknown-certainty' };
  if (input.mode === 'shell') return { store: false, skip: 'shell-mode' };
  const text = input.text;
  if (typeof text !== 'string' || text.length === 0 || whitespaceOnly(text)) {
    return { store: false, skip: 'empty' };
  }
  if (startsWithCommand(text)) return { store: false, skip: 'slash-command' };
  if (utf8Length(text) > MAX_TEXT_BYTES) return { store: false, skip: 'too-large' };
  const spans = input.typedSpans;
  if (spans === undefined || spans.length === 0) return { store: false, skip: 'no-typed-spans' };
  if (!spansCover(spans, 0, text.length)) return { store: false, skip: 'partial-typed' };
  return { store: true };
}

export function decideFromCommitted(
  event: SubmitCommitted,
  extra: { readonly certainty?: RecordInput['certainty']; readonly mode?: RecordInput['mode'] } = {},
): RecordDecision {
  return decideRecord({
    text: event.text,
    gesture: event.gesture,
    level: event.level,
    ...(event.typedSpans === undefined ? {} : { typedSpans: event.typedSpans }),
    ...(extra.certainty === undefined ? {} : { certainty: extra.certainty }),
    ...(extra.mode === undefined ? {} : { mode: extra.mode }),
  });
}

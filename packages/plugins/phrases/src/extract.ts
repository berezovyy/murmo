// Clause extraction for phrase learning. Typed-span filter and the skip rules (slash/!, shell, inferred-queue) live here so the plugin
// hook stays a thin caller (E4, E26, E27). Clauses are stored as typed: there
// is no secret detection.

import type { CommitLevel, Range, SubmitCommitted, SubmitGesture } from '@murmo/api';

export const MIN_WORDS = 3;
export const MAX_WORDS = 10;

export type SkipReason =
  | 'learn-off'
  | 'private'
  | 'no-typed-spans'
  | 'unknown-certainty'
  | 'slash-command'
  | 'shell-mode'
  | 'inferred-queue'
  | 'bad-gesture'
  | 'empty';

export interface ExtractInput {
  readonly text: string;
  readonly typedSpans?: readonly Range[];
  readonly gesture: SubmitGesture;
  readonly level: CommitLevel;
  readonly certainty?: 'authoritative' | 'tracked' | 'unknown';
  readonly mode?: 'prose' | 'shell' | 'command' | 'unknown';
}

export interface ExtractResult {
  readonly clauses: readonly string[];
  readonly skip?: SkipReason;
}

export interface ClauseSpan {
  readonly phrase: string;
  readonly from: number;
  readonly to: number;
}

const FENCE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE = /`[^`]*`/g;
const URL = /https?:\/\/[^\s]+/gi;
const POSIX_PATH = /(?:^|[\s])((?:\.{0,2}\/|~\/)[^\s]+)/gm;
const WIN_PATH = /[A-Za-z]:\\[^\s]+/g;
const WORD = /[A-Za-z0-9]+/g;
const BREAK = /[.;!?\n]/;

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

function mask(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => ' '.repeat(match.length));
}

function maskPosix(text: string): string {
  return text.replace(POSIX_PATH, (match, path: string) => {
    const lead = match.length - path.length;
    return match.slice(0, lead) + ' '.repeat(path.length);
  });
}

/** Replaces code, URLs and paths with spaces so offsets stay aligned. */
export function maskNonProse(text: string): string {
  return maskPosix(mask(mask(mask(mask(text, FENCE), INLINE), URL), WIN_PATH));
}

/**
 * Normalized 3–10 word clauses and their original ranges. A clause whose
 * range is not fully typed is dropped whole (lesson 52).
 */
export function extractClauseSpans(text: string, typedSpans: readonly Range[]): ClauseSpan[] {
  if (typedSpans.length === 0) return [];
  const masked = maskNonProse(text);
  const words: { word: string; from: number; to: number }[] = [];
  WORD.lastIndex = 0;
  for (const match of masked.matchAll(WORD)) {
    const from = match.index ?? 0;
    const word = text.slice(from, from + match[0].length);
    words.push({ word, from, to: from + match[0].length });
  }
  const out: ClauseSpan[] = [];
  let group: typeof words = [];
  const flush = () => {
    if (group.length >= MIN_WORDS && group.length <= MAX_WORDS) {
      const from = group[0]?.from ?? 0;
      const to = group[group.length - 1]?.to ?? from;
      if (spansCover(typedSpans, from, to)) {
        out.push({ phrase: group.map((w) => w.word).join(' '), from, to });
      }
    }
    group = [];
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word) continue;
    if (group.length === 0) {
      group.push(word);
      continue;
    }
    const prev = group[group.length - 1];
    if (!prev) continue;
    const between = text.slice(prev.to, word.from);
    if (BREAK.test(between) || group.length === MAX_WORDS) {
      flush();
      group.push(word);
    } else group.push(word);
  }
  flush();
  return out;
}

export function extractClauses(text: string, typedSpans: readonly Range[]): string[] {
  return extractClauseSpans(text, typedSpans).map((c) => c.phrase);
}

function startsWithCommand(text: string): boolean {
  const trimmed = text.replace(/^[ \t]+/, '');
  return trimmed.startsWith('/') || trimmed.startsWith('!');
}

/**
 * Policy for one `onSubmitCommitted` event. Returns clauses to store, or a
 * skip reason and no clauses (E26, E27).
 */
export function learnFromSubmit(input: ExtractInput): ExtractResult {
  if (input.gesture !== 'send' && input.gesture !== 'queue' && input.gesture !== 'steer') {
    return { clauses: [], skip: 'bad-gesture' };
  }
  if (input.level === 'inferred' && input.gesture !== 'send') {
    return { clauses: [], skip: 'inferred-queue' };
  }
  if (input.certainty === 'unknown') return { clauses: [], skip: 'unknown-certainty' };
  if (input.mode === 'shell') return { clauses: [], skip: 'shell-mode' };
  const text = input.text;
  if (text.length === 0) return { clauses: [], skip: 'empty' };
  if (startsWithCommand(text)) return { clauses: [], skip: 'slash-command' };
  const spans = input.typedSpans;
  if (spans === undefined || spans.length === 0) return { clauses: [], skip: 'no-typed-spans' };
  const clauses = extractClauses(text, spans);
  if (clauses.length === 0) return { clauses: [], skip: 'empty' };
  return { clauses };
}

/** Same policy against a `SubmitCommitted` snapshot. */
export function learnFromCommitted(
  event: SubmitCommitted,
  extra: { readonly certainty?: ExtractInput['certainty']; readonly mode?: ExtractInput['mode'] } = {},
): ExtractResult {
  return learnFromSubmit({
    text: event.text,
    gesture: event.gesture,
    level: event.level,
    ...(event.typedSpans === undefined ? {} : { typedSpans: event.typedSpans }),
    ...(extra.certainty === undefined ? {} : { certainty: extra.certainty }),
    ...(extra.mode === undefined ? {} : { mode: extra.mode }),
  });
}

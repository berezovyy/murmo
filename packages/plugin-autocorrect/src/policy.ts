// english-word-boundary-v1: skip, case, and language rules the core interpreter
// calls. No generic edit-distance fallback (engine-v2 `generic` is off for good).
// Case: preserve-title, plus round 8's lowercase-only keys (docs/plan/13).

import { ENGLISH_POLICY, type WordPolicy, type WordPolicyQuery, type WordProposal } from '@murmo/core';
import { normalizeKey } from '@murmo/lang';
import { isGraphemeBoundary } from '@murmo/text';
import { codeContext, inCode } from './code.ts';
import { editRangeIsSafe, isForeignLine, leadingDecorations, trailingDecorations } from './unicode.ts';

export { inCode };

/** Keys that correct only when typed in exactly this lowercase form (r8 case-policy.json). */
export const DEFAULT_LOWERCASE_ONLY: ReadonlySet<string> = new Set(['adn', 'teh', 'thier']);

/** Standalone `i` plus all-lowercase or title-case words; ALLCAPS and inner capitals stay. */
const CORRECTABLE = /^[a-z]+$|^[A-Z][a-z]+$|^I$/;
const SKIP_PREFIX = /^[/@!\-.]/;
const SKIP_BODY = /[_/\d]/;
const MAX_TOKEN = 64;

export interface EnglishPolicyOptions {
  /** Override the pack's lowercase-only set. Defaults to teh/adn/thier. */
  readonly lowercaseOnly?: ReadonlySet<string>;
}

export function createEnglishPolicy(options: EnglishPolicyOptions = {}): WordPolicy {
  const lowercaseOnly = options.lowercaseOnly ?? DEFAULT_LOWERCASE_ONLY;
  return {
    name: ENGLISH_POLICY,
    inCode,
    propose(query) {
      return proposeEnglish(query, lowercaseOnly);
    },
  };
}

function proposeEnglish(query: WordPolicyQuery, lowercaseOnly: ReadonlySet<string>): WordProposal | null {
  if (!Number.isInteger(query.cursor) || query.cursor < 0 || query.cursor > query.text.length) return null;
  if (!isGraphemeBoundary(query.text, query.cursor)) return null;
  const prefix = query.text.slice(0, query.cursor);
  const lineStart = prefix.lastIndexOf('\n') + 1;
  const nextNewline = query.text.indexOf('\n', query.cursor);
  const line = query.text.slice(lineStart, nextNewline < 0 ? query.text.length : nextNewline);
  if (isForeignLine(line)) return null;
  // Tokens are ≤ 64 units plus wrappers; do not scan a 1.1M-character prefix (E8).
  const window = prefix.length > 256 ? prefix.slice(-256) : prefix;
  const raw = /\S+$/.exec(window)?.[0];
  if (!raw) return null;
  const body = raw.slice(0, raw.length - trailingDecorations(raw));
  const left = leadingDecorations(body);
  const token = body.slice(left);
  if (!token || token.length > MAX_TOKEN || SKIP_PREFIX.test(token) || SKIP_BODY.test(token)) return null;
  if (!CORRECTABLE.test(token)) return null;
  // `I` is a one-letter correctable; protection keys are [a-z]{2,64}.
  const lower = normalizeKey(token) ?? (token === 'I' || token === 'i' ? 'i' : null);
  if (!lower) return null;
  if (query.rejected.has(lower) || query.vocabulary.has(lower)) return null;
  if (lowercaseOnly.has(lower) && token !== lower) return null;
  const found = query.lookup(lower);
  if (!found || found.includes('|')) return null;
  const replacement = /^[A-Z]/.test(token) ? found[0]?.toUpperCase() + found.slice(1) : found;
  if (!replacement || replacement === token) return null;
  const start = query.cursor - raw.length + left;
  const end = start + token.length;
  if (codeContext(query.text, start, query.cursor, query.typed) !== null) return null;
  if (!editRangeIsSafe(query.text, start, end)) return null;
  return { from: start, to: end, insert: replacement };
}

/** The policy registered for production; tests may pass a different lowercase-only set. */
export const englishPolicy: WordPolicy = createEnglishPolicy();

// Pure `autocorrect.lookupWord` for fixtures/lang-en/case-policy-r8.json.
// Same gates as lookup.mjs: language, origin, prose, vocabulary, rejected,
// plus the English skip/case policy. Generic fallback stays off.

import { mapTable, normalizeKey, type PackedTable, lookup as tableLookup } from '@murmo/lang';
import { createEnglishPolicy, DEFAULT_LOWERCASE_ONLY } from './policy.ts';
import { englishPackAsset } from './table-source.ts';

let mapped: PackedTable | undefined;
let mappedFrom: Uint8Array | undefined;

function packed(): PackedTable | undefined {
  const pack = englishPackAsset();
  if (!pack) return undefined;
  if (mappedFrom !== pack.bytes) {
    mapped = mapTable(pack.bytes);
    mappedFrom = pack.bytes;
  }
  return mapped;
}

export interface LookupContext {
  readonly language?: string;
  readonly origin?: string;
  readonly prose?: boolean;
  readonly vocabulary?: readonly string[];
  readonly rejected?: readonly string[];
}

export interface LookupInput {
  readonly token: string;
  readonly context?: LookupContext;
}

export interface LookupOutput {
  readonly fix: string | null;
}

export function lookupWord(input: unknown): LookupOutput {
  const { token, context } = input as LookupInput;
  if (typeof token !== 'string') return { fix: null };
  const language = context?.language ?? 'en';
  const origin = context?.origin ?? 'typed';
  const prose = context?.prose ?? true;
  if (language !== 'en' || origin !== 'typed' || !prose) return { fix: null };
  const pack = englishPackAsset();
  const table = packed();
  const lookup = table ? (word: string) => tableLookup(table, word) ?? null : () => null;
  const lowercaseOnly = pack ? new Set(pack.lowercaseOnly) : DEFAULT_LOWERCASE_ONLY;
  const policy = createEnglishPolicy({ lowercaseOnly });
  const rejected = new Set((context?.rejected ?? []).map((w) => normalizeKey(w) ?? w.toLowerCase()));
  const vocabulary = new Set((context?.vocabulary ?? []).map((w) => normalizeKey(w) ?? w.toLowerCase()));
  const proposed = policy.propose({
    text: token,
    cursor: token.length,
    typed: ' ',
    rejected,
    vocabulary,
    lookup,
  });
  return { fix: proposed?.insert ?? null };
}

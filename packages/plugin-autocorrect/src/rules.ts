// InlineRules data the host registers at load. No plugin function runs on the
// key path: this is the record `createInlineRules` used to build (E11).

import type { InlineRules } from '@murmo/api/adapter';
import {
  DEFAULT_INLINE_MAX_BYTES,
  ENGLISH_POLICY,
  exactLookupPolicy,
  MAX_INSERT_BYTES,
  REQUIRED_SKIP,
  registerPolicy,
} from '@murmo/core';
import { createEnglishPolicy } from './policy.ts';
import type { AutocorrectSettings } from './settings.ts';
import { correctionEnabled } from './settings.ts';
import type { EnglishPackAsset } from './table-source.ts';

export const AUTOCORRECT_RULE_ID = 'murmo-typos';
export const AUTOCORRECT_PRIORITY = 100;
export const TABLE_ASSET = 'english.bin';

export interface EnglishRulesOptions {
  readonly owner: string;
  readonly pack: EnglishPackAsset;
  readonly settings: AutocorrectSettings;
  /** Extra protected words (project vocabulary, fixture `settings.vocabulary`). */
  readonly vocabulary?: readonly string[];
  readonly asset?: string;
  readonly enabled?: boolean;
}

export interface EnglishInlineBundle {
  readonly rules: InlineRules;
  readonly assets: Readonly<Record<string, ArrayBuffer>>;
}

/** Replaces the phase-07 exact-lookup stand-in under the same policy name. */
export function installEnglishPolicy(lowercaseOnly?: ReadonlySet<string>): void {
  registerPolicy(createEnglishPolicy(lowercaseOnly ? { lowercaseOnly } : {}));
}

/** Restores the phase-07 stand-in so burst counts on the test table stay put. */
export function installTestPolicy(): void {
  registerPolicy(exactLookupPolicy);
}

export function englishInlineRules(options: EnglishRulesOptions): EnglishInlineBundle {
  installEnglishPolicy(new Set(options.pack.lowercaseOnly));
  const asset = options.asset ?? TABLE_ASSET;
  const bytes = options.pack.bytes;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  if (!(copy.buffer instanceof ArrayBuffer)) throw new TypeError('english table bytes need an ArrayBuffer');
  const vocabulary = uniqueLower([...options.settings.allow, ...(options.vocabulary ?? [])]);
  const enabled = options.enabled ?? correctionEnabled(options.settings);
  const rules: InlineRules = {
    id: AUTOCORRECT_RULE_ID,
    owner: options.owner,
    priority: AUTOCORRECT_PRIORITY,
    enabled,
    policy: ENGLISH_POLICY,
    table: {
      format: 'packed-sorted-ascii-v1',
      asset,
      sha256: options.pack.sha256,
      entries: options.pack.entries,
    },
    language: 'en',
    boundaries: ' .,;:!?',
    case: 'preserve-title',
    dot: 'wait-next-typed-key',
    origin: 'fully-typed-span',
    skip: [...REQUIRED_SKIP],
    ...(vocabulary.length ? { vocabulary } : {}),
    inlineMaxInsertBytes: DEFAULT_INLINE_MAX_BYTES,
    maxInsertBytes: MAX_INSERT_BYTES,
    rejectMemory: 'per-draft',
  };
  return { rules, assets: { [asset]: copy.buffer } };
}

function uniqueLower(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    const lower = word.toLowerCase();
    if (!lower || seen.has(lower)) continue;
    seen.add(lower);
    out.push(word);
  }
  return out;
}

// Session-facing protection: load the packed table through one fd, union
// sources 1–2, and swap the object between keys. Adapters call `refresh`
// while idle; a missing table means only [words] protect and the allowlist.

import { type RegisteredInline, registerRuleSet, type Session } from '@murmo/core';
import { type EnglishPackAsset, englishInlineRules, resolveAutocorrectSettings } from '@murmo/plugin-autocorrect';
import { IDLE_CHECK_MS, type ProtectionTable, protectedWords } from '../index.ts';
import { protectionMtime, tryReadProtection } from './load.ts';

export interface ProtectionLive {
  /** Collision keys ∪ sources 1–2, ready for InlineRules.vocabulary. */
  vocabulary(): readonly string[];
  table(): ProtectionTable | undefined;
  /**
   * One-fd load when the file mtime changed. Returns true when the live
   * table object was replaced.
   */
  refresh(): boolean;
}

export function createProtectionLive(options: {
  readonly cacheDir: string;
  readonly extra: readonly string[];
}): ProtectionLive {
  let table = tryReadProtection(options.cacheDir);
  let mtime = protectionMtime(options.cacheDir);
  let words = protectedWords(table?.packed, options.extra);
  return {
    vocabulary: () => words,
    table: () => table,
    refresh() {
      const nextMtime = protectionMtime(options.cacheDir);
      if (nextMtime === mtime) return false;
      const next = tryReadProtection(options.cacheDir);
      mtime = nextMtime;
      table = next;
      words = protectedWords(next?.packed, options.extra);
      return true;
    },
  };
}

export function registerProtectedInline(
  pack: EnglishPackAsset,
  settings: Readonly<Record<string, unknown>>,
  vocabulary: readonly string[],
): RegisteredInline {
  const resolved = resolveAutocorrectSettings(settings);
  const bundle = englishInlineRules({ owner: 'autocorrect', pack, settings: resolved, vocabulary });
  return registerRuleSet(bundle.rules, {
    owner: 'autocorrect',
    builtin: true,
    permissions: ['draft:read', 'draft:write'],
    assets: bundle.assets,
    transportMaxBytes: 16384,
  });
}

/** Swap the autocorrect rule's vocabulary between keys (core `replaceInline`). */
export function swapProtectedInline(
  session: Session,
  pack: EnglishPackAsset,
  settings: Readonly<Record<string, unknown>>,
  vocabulary: readonly string[],
): void {
  session.replaceInline(registerProtectedInline(pack, settings, vocabulary));
}

export { IDLE_CHECK_MS };

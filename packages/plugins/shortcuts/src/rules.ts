// InlineRules record the core registers. The plugin never decides an expansion.

import type { PluginFactory } from '@murmo/api';
import type { InlineRules } from '@murmo/api/adapter';
import {
  type CompiledShortcuts,
  INLINE_MAX_BYTES,
  MAX_INSERT_BYTES,
  replacementsForSpace,
  SHORTCUTS_ID,
  SHORTCUTS_PRIORITY,
  SHORTCUTS_VERSION,
} from './compile.ts';

const SKIP = ['code', 'path', 'URL', 'flag', 'identifier', 'foreign-letter-line'] as const;

export interface InlineCapOptions {
  readonly asyncEdits?: boolean;
  readonly inlineMaxBytes?: number;
}

export function shortcutsInlineRules(
  owner: string,
  compiled: CompiledShortcuts,
  options: InlineCapOptions = {},
): InlineRules {
  const asyncEdits = options.asyncEdits ?? true;
  const inlineMax = options.inlineMaxBytes ?? INLINE_MAX_BYTES;
  return {
    id: `${owner}-literal`,
    owner,
    priority: SHORTCUTS_PRIORITY,
    enabled: true,
    policy: 'english-word-boundary-v1',
    language: 'en',
    boundaries: ' .,;:!?',
    case: 'preserve-title',
    dot: 'wait-next-typed-key',
    origin: 'fully-typed-span',
    skip: [...SKIP],
    replacements: { format: 'literal-utf8-v1', entries: replacementsForSpace(compiled, asyncEdits) },
    inlineMaxInsertBytes: inlineMax,
    maxInsertBytes: MAX_INSERT_BYTES,
    rejectMemory: 'per-draft',
  };
}

/** Built-in spec the session/host registers: data only, no async expansion path. */
export function shortcutsPlugin(
  compiled: CompiledShortcuts,
  options: InlineCapOptions = {},
): {
  readonly id: string;
  readonly builtin: true;
  readonly factory: PluginFactory;
  readonly inline: readonly InlineRules[];
} {
  return {
    id: SHORTCUTS_ID,
    builtin: true,
    factory: shortcutsFactory,
    inline: [shortcutsInlineRules(SHORTCUTS_ID, compiled, options)],
  };
}

export const shortcutsFactory: PluginFactory = () => ({
  name: SHORTCUTS_ID,
  version: SHORTCUTS_VERSION,
  permissions: ['draft:read', 'draft:write'],
});

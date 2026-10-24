// InlineRules record the core registers. Field-session hooks (Tab/Esc/submit)
// run off the key path from cached ranges (phase 37).

import type { HostName, Plugin, PluginFactory } from '@murmo/api';
import type { InlineRules } from '@murmo/api/adapter';
import {
  type CompiledShortcuts,
  compileShortcuts,
  INLINE_MAX_BYTES,
  MAX_INSERT_BYTES,
  replacementsForSpace,
  SHORTCUTS_ID,
  SHORTCUTS_PRIORITY,
  SHORTCUTS_VERSION,
} from './compile.ts';
import { shortcutRecords } from './records.ts';
import { createShortcutsHooks, DEFAULT_PREVIOUS_FIELD, fieldClaims, type TemplateBox } from './session.ts';

const SKIP = ['code', 'path', 'URL', 'flag', 'identifier', 'foreign-letter-line'] as const;

export interface InlineCapOptions {
  readonly asyncEdits?: boolean;
  readonly inlineMaxBytes?: number;
  readonly host?: HostName;
  readonly previousFieldKey?: string;
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
    replacements: {
      format: 'literal-utf8-v1',
      entries: replacementsForSpace(compiled, asyncEdits),
      cursors: compiled.inline.cursors,
    },
    inlineMaxInsertBytes: inlineMax,
    maxInsertBytes: MAX_INSERT_BYTES,
    rejectMemory: 'per-draft',
  };
}

function hostOf(value: unknown, fallback: HostName = 'fake'): HostName {
  return value === 'pi' || value === 'opencode' || value === 'claude' || value === 'codex' || value === 'fake'
    ? value
    : fallback;
}

function createPlugin(box: TemplateBox, options: InlineCapOptions = {}): Plugin {
  const host = options.host ?? 'fake';
  const previousFieldKey = options.previousFieldKey ?? DEFAULT_PREVIOUS_FIELD;
  const hooks = createShortcutsHooks(box, { previousFieldKey });
  return {
    name: SHORTCUTS_ID,
    version: SHORTCUTS_VERSION,
    permissions: ['draft:read', 'draft:read:full', 'draft:write', 'submit', 'submit:observe'],
    keys: fieldClaims(previousFieldKey, host),
    onChange: hooks.onChange,
    onKey: hooks.onKey,
    onBeforeSubmit: hooks.onBeforeSubmit,
    onSubmitCommitted: hooks.onSubmitCommitted,
  };
}

/** Built-in spec the session/host registers. */
export function shortcutsPlugin(
  compiled: CompiledShortcuts,
  options: InlineCapOptions = {},
): {
  readonly id: string;
  readonly builtin: true;
  readonly factory: PluginFactory;
  readonly inline: readonly InlineRules[];
} {
  const box: TemplateBox = { compiled };
  return {
    id: SHORTCUTS_ID,
    builtin: true,
    factory: () => createPlugin(box, options),
    inline: [shortcutsInlineRules(SHORTCUTS_ID, compiled, options)],
  };
}

function compiledFrom(settings: Readonly<Record<string, unknown>>): CompiledShortcuts {
  return compileShortcuts({ replacements: shortcutRecords(settings.replacements) });
}

/** Conformance/factory entry: settings.replacements (text or `[replace]` tables) plus optional host / previousFieldKey. */
export const shortcutsFactory: PluginFactory = (settings) =>
  createPlugin(
    { compiled: compiledFrom(settings) },
    {
      host: hostOf(settings.host),
      ...(typeof settings.previousFieldKey === 'string' ? { previousFieldKey: settings.previousFieldKey } : {}),
    },
  );

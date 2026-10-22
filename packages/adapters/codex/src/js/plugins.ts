// Built-in plugin specs for the trusted executor. Third-party plugins are
// loaded by the Rust helper, not here.

import type { HostPluginSpec } from '@murmo/core';
import { autocorrectSpec, provideEnglishPack } from '@murmo/plugin-autocorrect';
import { historyPlugin } from '@murmo/plugin-history';
import { memoryBackend, namesPlugin } from '@murmo/plugin-names';
import { phrasesPlugin } from '@murmo/plugin-phrases';
import { rescuePlugin } from '@murmo/plugin-rescue';
import { compileShortcuts, menuPlugin, shortcutsPlugin } from '@murmo/plugin-shortcuts';
import { createMemoryDrafts } from '@murmo/store';
import { INLINE_MAX_BYTES } from './caps.ts';
import { sha256 } from './host.ts';

export interface EngineConfig {
  readonly hostVersion?: string;
  readonly autocorrect?: boolean;
  readonly replacements?: Readonly<Record<string, string>>;
  readonly pluginOrder?: readonly string[];
  readonly overlay?: boolean;
  readonly hide?: string;
  readonly events?: boolean;
  readonly history?: boolean;
}

export interface TableMeta {
  readonly sha256?: string;
  readonly entries?: number;
  readonly bytes?: number;
  readonly lowercaseOnly?: readonly string[];
  readonly asset?: string;
}

export function installTable(bytes: Uint8Array | undefined, meta: TableMeta): void {
  if (!bytes || !meta.sha256 || !meta.entries) return;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hash = sha256(copy);
  if (hash !== 'missing' && hash !== meta.sha256) return;
  provideEnglishPack({
    bytes: copy,
    sha256: meta.sha256,
    entries: meta.entries,
    lowercaseOnly: meta.lowercaseOnly ?? [],
  });
}

export function builtinSpecs(config: EngineConfig): HostPluginSpec[] {
  const replacements = config.replacements ?? {};
  const compiled = compileShortcuts({
    replacements: Object.entries(replacements).map(([shortcut, text]) => ({
      shortcut,
      text,
      origin: 'user' as const,
    })),
    asyncEdits: true,
    inlineMaxBytes: INLINE_MAX_BYTES,
  });
  const autocorrect = autocorrectSpec('autocorrect', { enabled: config.autocorrect === true });
  const specs: HostPluginSpec[] = [
    {
      id: autocorrect.id,
      builtin: true,
      factory: autocorrect.factory,
      settings: autocorrect.settings,
      ...(autocorrect.inline ? { inline: autocorrect.inline } : {}),
      ...(autocorrect.assets ? { assets: autocorrect.assets } : {}),
    },
    shortcutsPlugin(compiled, { asyncEdits: true, inlineMaxBytes: INLINE_MAX_BYTES }),
    (() => {
      const menu = menuPlugin(compiled, {
        width: 80,
        history: config.history === true,
      });
      return { id: menu.id, builtin: true as const, factory: menu.factory };
    })(),
    rescuePlugin({
      drafts: createMemoryDrafts(),
      identity: { project: '0'.repeat(64), host: 'codex', session: 'session' },
    }),
    phrasesPlugin({ identity: { project: '0'.repeat(64), host: 'codex', session: 'session' } }, { ghost: false }),
    historyPlugin(
      { identity: { project: '0'.repeat(64), host: 'codex', session: 'session' } },
      { enabled: config.history === true },
    ),
    (() => {
      const names = namesPlugin(memoryBackend([]), { enabled: true }, 'codex');
      return { id: names.id, builtin: true as const, factory: names.factory, settings: { enabled: true } };
    })(),
  ];
  const order = config.pluginOrder;
  if (!order?.length) return specs;
  const byId = new Map(specs.map((s) => [s.id, s]));
  const ordered: HostPluginSpec[] = [];
  for (const id of order) {
    const spec = byId.get(id);
    if (spec) ordered.push(spec);
  }
  for (const spec of specs) {
    if (!ordered.some((s) => s.id === spec.id)) ordered.push(spec);
  }
  return ordered;
}

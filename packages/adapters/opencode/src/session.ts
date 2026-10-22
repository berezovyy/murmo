// Wire createSession + in-process built-ins. Third-party plugins take the
// isolated executor seam (phase 10); v1 only loads built-ins here.

import type { Executor } from '@murmo/api/adapter';
import type { EffectiveConfig } from '@murmo/config';
import { createMemoryStorage, createPluginHost, createSession, type HostPluginSpec, type Session } from '@murmo/core';
import { createInProcessExecutor } from '@murmo/executor';
import { autocorrectSpec } from '@murmo/plugin-autocorrect';
import { findShippedEnglishDir, loadBuiltPack } from '@murmo/plugin-autocorrect/node/from-dir';
import { historyPlugin } from '@murmo/plugin-history';
import { memoryBackend, namesPlugin } from '@murmo/plugin-names';
import { phrasesPlugin } from '@murmo/plugin-phrases';
import { rescuePlugin } from '@murmo/plugin-rescue';
import { compileShortcuts, menuPlugin, shortcutsPlugin } from '@murmo/plugin-shortcuts';
import { createMemoryDrafts } from '@murmo/store';
import type { OpenCodeAdapter } from './adapter.ts';

export interface SessionStartOptions {
  readonly adapter: OpenCodeAdapter;
  readonly plugins?: readonly HostPluginSpec[];
  readonly order?: readonly string[];
  readonly executor?: Executor;
  readonly config?: EffectiveConfig;
  readonly replacements?: readonly {
    readonly shortcut: string;
    readonly text: string;
    readonly origin: 'user' | 'project';
  }[];
  readonly loadLanguagePack?: boolean;
  readonly notify?: (message: string) => void;
}

export interface StartedSession {
  readonly session: Session;
  close(): Promise<void>;
}

function builtinPlugins(options: SessionStartOptions): HostPluginSpec[] {
  if (options.plugins) return [...options.plugins];
  if (options.loadLanguagePack !== false) {
    try {
      const dir = findShippedEnglishDir();
      if (dir) loadBuiltPack(dir);
    } catch {
      // Pack missing in unit tests; autocorrectSpec then ships without a table.
    }
  }
  const replacements = options.replacements ?? options.config?.replacements ?? [];
  const compiled = compileShortcuts({
    replacements: replacements.map((entry) => ({
      shortcut: entry.shortcut,
      text: entry.text,
      origin: entry.origin,
    })),
    ...(options.config?.overrides ? { overrides: options.config.overrides } : {}),
    trust: 'none',
    asyncEdits: true,
  });
  const autocorrect = autocorrectSpec('autocorrect', {
    enabled: options.config?.autocorrect === true,
    allow: (options.config?.protect ?? []).join(' '),
  });
  const shortcuts = shortcutsPlugin(compiled);
  const historyOn = options.config?.historyEnabled === true;
  const menu = menuPlugin(compiled, { history: historyOn });
  const specs: HostPluginSpec[] = [
    {
      id: autocorrect.id,
      builtin: true,
      factory: autocorrect.factory,
      settings: autocorrect.settings,
      ...(autocorrect.inline ? { inline: autocorrect.inline } : {}),
      ...(autocorrect.assets ? { assets: autocorrect.assets } : {}),
    },
    { id: shortcuts.id, builtin: true, factory: shortcuts.factory, inline: [...shortcuts.inline] },
    { id: menu.id, builtin: true, factory: menu.factory },
    rescuePlugin({
      drafts: createMemoryDrafts(),
      identity: { host: 'opencode', project: '0'.repeat(64), session: 'opencode-session' },
    }),
    phrasesPlugin(
      { identity: { project: '0'.repeat(64), host: 'opencode', session: 'opencode-session' } },
      { learn: options.config?.phrasesLearn === true },
    ),
    historyPlugin(
      { identity: { project: '0'.repeat(64), host: 'opencode', session: 'opencode-session' } },
      { enabled: historyOn },
    ),
    (() => {
      const settings = {
        enabled: options.config?.names?.enabled !== false,
        ...(options.config?.names?.key ? { key: options.config.names.key } : {}),
      };
      const names = namesPlugin(memoryBackend([]), settings, 'opencode');
      return { id: names.id, builtin: true as const, factory: names.factory, settings };
    })(),
  ];
  return specs;
}

export async function startSession(options: SessionStartOptions): Promise<StartedSession> {
  const executor = options.executor ?? createInProcessExecutor();
  const host = createPluginHost({
    specs: builtinPlugins(options),
    executor,
    storage: createMemoryStorage(),
  });
  const session = createSession({
    adapter: options.adapter,
    runner: host,
    keyBursts: true,
    ...(options.order ? { order: options.order } : {}),
    ...(options.notify ? { notify: options.notify } : {}),
  });
  await session.ready;
  return {
    session,
    async close() {
      await session.dispose();
      await executor.dispose();
    },
  };
}

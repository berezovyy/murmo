// Wire createSession + in-process built-ins. Third-party plugins take the
// isolated executor seam (phase 10); v1 only loads built-ins here.

import type { Executor } from '@murmo/api/adapter';
import type { EffectiveConfig, LoadedSession } from '@murmo/config';
import { loadedSession, loadSessionConfig } from '@murmo/config/node';
import { createMemoryStorage, createPluginHost, createSession, type HostPluginSpec, type Session } from '@murmo/core';
import { createInProcessExecutor } from '@murmo/executor';
import { autocorrectSpec } from '@murmo/plugin-autocorrect';
import { findShippedEnglishDir, loadBuiltPack } from '@murmo/plugin-autocorrect/node/from-dir';
import { historyPlugin } from '@murmo/plugin-history';
import { memoryBackend, namesPlugin } from '@murmo/plugin-names';
import { phrasesPlugin } from '@murmo/plugin-phrases';
import { rescuePlugin } from '@murmo/plugin-rescue';
import {
  type CompileShortcut,
  compileConfigShortcuts,
  menuPlugin,
  sessionNotices,
  shortcutsPlugin,
} from '@murmo/plugin-shortcuts';
import { createMemoryDrafts } from '@murmo/store';
import { openStore, storeRootsFromEnv } from '@murmo/store/node';
import type { OpenCodeAdapter } from './adapter.ts';

export interface SessionStartOptions {
  readonly adapter: OpenCodeAdapter;
  readonly plugins?: readonly HostPluginSpec[];
  readonly order?: readonly string[];
  readonly executor?: Executor;
  readonly config?: EffectiveConfig;
  /** The load `config` came from: project trust and summary for the startup notices. */
  readonly session?: Pick<LoadedSession, 'trust' | 'project'>;
  /** Startup notices ahead of the session's own (a config that failed to load). */
  readonly notices?: readonly string[];
  readonly replacements?: readonly CompileShortcut[];
  readonly loadLanguagePack?: boolean;
  readonly notify?: (message: string) => void;
}

export interface StartedSession {
  readonly session: Session;
  close(): Promise<void>;
}

function builtinPlugins(options: SessionStartOptions): { specs: HostPluginSpec[]; notices: string[] } {
  if (options.plugins) return { specs: [...options.plugins], notices: [] };
  if (options.loadLanguagePack !== false) {
    try {
      const dir = findShippedEnglishDir();
      if (dir) loadBuiltPack(dir);
    } catch {
      // Pack missing in unit tests; autocorrectSpec then ships without a table.
    }
  }
  const replacements = options.replacements ?? options.config?.replacements ?? [];
  const compiled = compileConfigShortcuts(
    {
      replacements,
      overrides: options.config?.overrides ?? [],
      ...(options.config ? { diagnostics: options.config.diagnostics } : {}),
    },
    { ...(options.session ? { session: options.session } : {}), asyncEdits: true },
  );
  const project = options.session?.project;
  const notices = options.config
    ? sessionNotices({ effective: options.config, ...(project ? { project } : {}) }, compiled)
    : compiled.notices.map((notice) => notice.text);
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
  return { specs, notices };
}

/** User `murmo.toml` plus project file, with project trust. Missing files leave autocorrect off (opt-in). */
export async function loadHostSession(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedSession> {
  const store = await openStore({ roots: storeRootsFromEnv(env) });
  return loadedSession(await loadSessionConfig({ cwd, store, env }));
}

/** The startup notice for a config that failed to load: built-ins still run, but without the user's shortcuts. */
export function configLoadNotice(error: unknown): string {
  const why = error instanceof Error ? error.message : String(error);
  // The cause goes last: the footer cuts long rows, and the action must stay.
  return `Murmo could not load murmo.toml; shortcuts are off this session: ${why}`;
}

/**
 * The session's config and trust, or the notice that says why there is none.
 * OpenCode 2.0.32 once failed this load and the error was swallowed, so
 * shortcuts stayed literal while setup and doctor said all was fine. Built-ins
 * still load without it.
 */
export async function hostSessionOptions(
  load: () => Promise<LoadedSession>,
): Promise<Pick<SessionStartOptions, 'config' | 'session' | 'notices'>> {
  try {
    const session = await load();
    return { config: session.effective, session };
  } catch (error) {
    return { notices: [configLoadNotice(error)] };
  }
}

export async function startSession(options: SessionStartOptions): Promise<StartedSession> {
  const executor = options.executor ?? createInProcessExecutor();
  const builtins = builtinPlugins(options);
  const host = createPluginHost({
    specs: builtins.specs,
    executor,
    storage: createMemoryStorage(),
  });
  const session = createSession({
    adapter: options.adapter,
    runner: host,
    keyBursts: true,
    notices: [...(options.notices ?? []), ...builtins.notices],
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

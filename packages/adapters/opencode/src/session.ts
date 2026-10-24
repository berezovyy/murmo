// Wire createSession: built-ins in-process, the plugins `murmo plugin add`
// installed in the isolated helper with their reviewed grants.

import type { Clock } from '@murmo/api';
import type { Executor } from '@murmo/api/adapter';
import {
  changedBuiltins,
  type EffectiveConfig,
  type LoadedSession,
  restartNotice,
  restartSettings,
  watchConfig,
} from '@murmo/config';
import { loadedSession, loadSessionConfig, recheckSessionConfig } from '@murmo/config/node';
import {
  createMemoryStorage,
  createPluginHost,
  createSession,
  followPlugins,
  type HostPluginSpec,
  type PluginHost,
  type PluginTables,
  pluginStates,
  reloadPlugins,
  type Session,
  withInstalled,
} from '@murmo/core';
import { createInProcessExecutor, createRoutedExecutor } from '@murmo/executor';
import { createNodeIsolatedExecutor } from '@murmo/executor/node';
import { autocorrectSpec } from '@murmo/plugin-autocorrect';
import { findShippedEnglishDir, loadBuiltPack } from '@murmo/plugin-autocorrect/node/from-dir';
import { historyPlugin } from '@murmo/plugin-history';
import { memoryBackend, namesPlugin } from '@murmo/plugin-names';
import { phrasesPlugin } from '@murmo/plugin-phrases';
import { findOffer, type RescueOptions, rescuePlugin } from '@murmo/plugin-rescue';
import {
  type CompileShortcut,
  compileConfigShortcuts,
  menuPlugin,
  sessionNotices,
  shortcutsPlugin,
} from '@murmo/plugin-shortcuts';
import { createMemoryDrafts, EMPTY_SELECTION, newDraftSession } from '@murmo/store';
import {
  openStore,
  projectIdOfCwd,
  readInstalledPlugins,
  storeRootsFromEnv,
  watchPluginSelection,
} from '@murmo/store/node';
import type { OpenCodeAdapter } from './adapter.ts';

export interface SessionStartOptions {
  readonly adapter: OpenCodeAdapter;
  /** Tests: these specs instead of the built-ins and the installed plugins. */
  readonly plugins?: readonly HostPluginSpec[];
  readonly order?: readonly string[];
  readonly executor?: Executor;
  /** Where installed third-party plugins run; default the isolated helper. Tests pass a stand-in. */
  readonly thirdParty?: (clock: Clock) => Executor;
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: EffectiveConfig;
  /** The load `config` came from: project trust and summary for the startup notices. */
  readonly session?: Pick<LoadedSession, 'trust' | 'project'>;
  /** Startup notices ahead of the session's own (a config that failed to load). */
  readonly notices?: readonly string[];
  readonly replacements?: readonly CompileShortcut[];
  readonly loadLanguagePack?: boolean;
  readonly notify?: (message: string) => void;
  /** Draft rescue on the file store (`prepareRescue`); without it drafts stay in memory (tests). */
  readonly rescue?: RescueOptions;
  /**
   * Re-checks the config files: the new load when one changed, else
   * undefined. Without it the session keeps the config it started with.
   */
  readonly recheck?: () => Promise<LoadedSession | undefined>;
  /** How often `recheck` runs; default `RECHECK_MS`. */
  readonly recheckMs?: number;
}

/** A session's config and the re-check that follows its files. */
export interface FollowedSession {
  readonly session: LoadedSession;
  recheck(): Promise<LoadedSession | undefined>;
}

/** A timer that never keeps OpenCode's process alive. */
function idleTimer(ms: number, callback: () => void): () => void {
  const handle = setTimeout(callback, ms);
  handle.unref?.();
  return () => clearTimeout(handle);
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
  // Where Murmo cannot edit the prompt the adapter says shortcuts and
  // autocorrect are off; "murmo on · 5 shortcuts" next to it was a false claim.
  const hint = options.adapter.canEdit();
  const notices = options.config
    ? sessionNotices({ effective: options.config, ...(project ? { project } : {}) }, compiled, { hint })
    : compiled.notices.map((notice) => notice.text);
  const autocorrect = autocorrectSpec('autocorrect', {
    enabled: options.config?.autocorrect === true,
    allow: (options.config?.protect ?? []).join(' '),
  });
  const shortcuts = shortcutsPlugin(compiled, { host: 'opencode' });
  const historyOn = options.config?.historyEnabled === true;
  const menu = menuPlugin(compiled, { history: historyOn });
  // One identity for every built-in: this project and session (`prepareRescue`).
  const rescue = options.rescue ?? {
    drafts: createMemoryDrafts(),
    identity: { host: 'opencode' as const, project: '0'.repeat(64), session: newDraftSession('opencode') },
  };
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
    rescuePlugin(rescue),
    phrasesPlugin({ identity: rescue.identity }, { learn: options.config?.phrasesLearn === true }),
    historyPlugin({ identity: rescue.identity }, { enabled: historyOn }),
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

/**
 * User `murmo.toml` plus project file, with project trust, and the re-check
 * that reloads them when one changes (an edit, `murmo trust`, `murmo words`).
 * Missing files leave autocorrect off (opt-in).
 */
export async function followHostSession(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<FollowedSession> {
  const store = await openStore({ roots: storeRootsFromEnv(env) });
  const options = { cwd, store, env };
  let current = await loadSessionConfig(options);
  return {
    session: loadedSession(current),
    async recheck() {
      const next = await recheckSessionConfig(current, options);
      if (!next) return undefined;
      current = next;
      return loadedSession(next);
    },
  };
}

/** The session's config once, without the re-check. */
export async function loadHostSession(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedSession> {
  return (await followHostSession(cwd, env)).session;
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
  load: () => Promise<FollowedSession>,
): Promise<Pick<SessionStartOptions, 'config' | 'session' | 'notices' | 'recheck'>> {
  try {
    const { session, recheck } = await load();
    return { config: session.effective, session, recheck };
  } catch (error) {
    return { notices: [configLoadNotice(error)] };
  }
}

/**
 * Draft rescue for a session in `cwd`: the file store, this project's
 * identity with a new session id, and the offer looked up now, before the
 * session starts, so it shows on the empty prompt at once.
 */
export async function prepareRescue(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  isPrivate?: () => boolean,
): Promise<RescueOptions> {
  const store = await openStore({ roots: storeRootsFromEnv(env) });
  const identity = {
    project: await projectIdOfCwd(cwd),
    host: 'opencode' as const,
    session: newDraftSession('opencode'),
  };
  const offer = await findOffer(store.drafts, identity);
  return {
    drafts: store.drafts,
    identity,
    ...(isPrivate ? { isPrivate } : {}),
    ...(offer ? { offer } : {}),
  };
}

/**
 * An edited config applies without a restart: the built-ins it configures
 * reload and the startup notices follow (the trust notice goes once the
 * project file is approved). `installed` are the installed plugins' notices.
 */
/** What the session runs now: config edits change it, the plugin follower reads it. */
interface LiveState {
  builtins: readonly HostPluginSpec[];
  tables: PluginTables;
}

function follow(
  session: Session,
  host: PluginHost,
  options: SessionStartOptions,
  installed: readonly string[],
  live: LiveState,
): () => void {
  const recheck = options.recheck;
  const started = options.session && options.config ? { ...options.session, effective: options.config } : undefined;
  if (!recheck || !started || options.plugins) return () => {};
  let current: LoadedSession = started;
  return watchConfig({
    ...(options.recheckMs === undefined ? {} : { everyMs: options.recheckMs }),
    after: idleTimer,
    check: async () => {
      const next = await recheck();
      if (!next) return;
      const previous = current;
      current = next;
      const { replacements: _fixed, notices: _failed, ...rest } = options;
      const rebuilt = builtinPlugins({ ...rest, config: next.effective, session: next, loadLanguagePack: false });
      live.builtins = rebuilt.specs;
      live.tables = next.effective.plugins;
      const changed = new Set(changedBuiltins(previous.effective, next.effective));
      await reloadPlugins(
        session,
        host,
        rebuilt.specs.filter((spec) => changed.has(spec.id)),
      );
      session.restateNotices([
        ...restartNotice(restartSettings(started.effective, next.effective)),
        ...rebuilt.notices,
        ...installed,
      ]);
    },
  });
}

function sessionExecutor(thirdParty: SessionStartOptions['thirdParty']): Executor {
  const trusted = createInProcessExecutor();
  return createRoutedExecutor({
    trusted,
    isolated: () => thirdParty?.(trusted.clock) ?? createNodeIsolatedExecutor({ clock: trusted.clock }),
  });
}

export async function startSession(options: SessionStartOptions): Promise<StartedSession> {
  const builtins = builtinPlugins(options);
  const roots = storeRootsFromEnv(options.env);
  const selection = options.plugins ? EMPTY_SELECTION : await readInstalledPlugins(roots);
  const loaded = withInstalled(
    { specs: builtins.specs, order: options.order ?? builtins.specs.map((spec) => spec.id), grants: {} },
    selection,
    options.config?.plugins,
  );
  const live: LiveState = { builtins: builtins.specs, tables: options.config?.plugins ?? {} };
  const executor = options.executor ?? sessionExecutor(options.thirdParty);
  const host = createPluginHost({
    specs: loaded.specs,
    executor,
    grants: loaded.grants,
    // The namespaces `murmo plugin` snapshots, migrates and rolls back; a
    // test's own plugin list keeps them in memory.
    ...(options.plugins ? { storage: createMemoryStorage() } : { broker: (await openStore({ roots })).plugins }),
  });
  const session = createSession({
    adapter: options.adapter,
    runner: host,
    keyBursts: true,
    notices: [...(options.notices ?? []), ...builtins.notices, ...loaded.notices],
    order: loaded.order,
    ...(options.notify ? { notify: options.notify } : {}),
  });
  await session.ready;
  const stopWatch = follow(session, host, options, loaded.notices, live);
  // `murmo plugin add`, `enable`, `disable`, `remove` and grant changes apply
  // to this session as they happen; the CLI waits for this session's ack.
  const follower = followPlugins(selection, {
    session,
    host,
    builtins: () => live.builtins,
    tables: () => live.tables,
  });
  const following = options.plugins
    ? undefined
    : await watchPluginSelection({
        roots,
        sessionId: newDraftSession('opencode'),
        host: 'opencode',
        started: { revision: selection.revision, plugins: pluginStates(session) },
        apply: (next) => follower.apply(next),
      });
  return {
    session,
    async close() {
      stopWatch();
      await following?.stop();
      await session.dispose();
      await executor.dispose();
    },
  };
}

// Wire the core session, built-in plugins, config and the helper.
//
// Config comes from the helper's `config.load` (phase 14): Claude's runtime
// has no lstat, realpath or O_NOFOLLOW, so only the helper can check a
// project `.murmo.toml` against its approval the way Pi and OpenCode do. The
// helper starts in a few milliseconds; while it can't answer, the session runs
// on the personal file alone and says why project shortcuts are off.

import type { Clock } from '@murmo/api';
import type { Executor } from '@murmo/api/adapter';
import {
  changedBuiltins,
  type LoadedSession,
  mergeConfig,
  resolveShortcuts,
  restartNotice,
  restartSettings,
  sessionFromJson,
  watchConfig,
} from '@murmo/config';
import {
  createMemoryProjectFiles,
  createMemoryStorage,
  createPluginHost,
  createSession,
  type EventBroker,
  followPlugins,
  type HostPluginSpec,
  type InstalledSelection,
  type PluginFollowerOptions,
  type PluginHost,
  reloadPlugins,
  type Session,
  withInstalled,
} from '@murmo/core';
import { createClock, createInProcessExecutor, createRoutedExecutor } from '@murmo/executor';
import { mapTable } from '@murmo/lang';
import {
  autocorrectFactory,
  englishInlineRules,
  provideEnglishPack,
  resolveAutocorrectSettings,
} from '@murmo/plugin-autocorrect';
import { historyPlugin } from '@murmo/plugin-history';
import { memoryBackend, namesPlugin } from '@murmo/plugin-names';
import { phrasesPlugin } from '@murmo/plugin-phrases';
import { findOffer, type RescueOptions, rescuePlugin } from '@murmo/plugin-rescue';
import {
  compileConfigShortcuts,
  menuPlugin,
  noticeShortForms,
  sessionNotices,
  shortcutsPlugin,
} from '@murmo/plugin-shortcuts';
import {
  createMemoryDrafts,
  createRemoteDrafts,
  createRemoteStore,
  EMPTY_SELECTION,
  newDraftSession,
  remoteProjectId,
  type StoreReply,
  type StoreTransport,
} from '@murmo/store';
import { ClaudeAdapter, type ClaudeAdapterOptions } from './adapter.ts';
import { bytesOf } from './decode.ts';
import { createClaudeBroker } from './events.ts';
import { type HelperHandle, type HelperWatch, isolatedFrom, socketDir, superviseHelper } from './helper.ts';
import {
  helperPaths,
  type IntegrityFile,
  type LocatedPayload,
  loadTable,
  locatePayload,
  type PayloadTable,
  parseUserConfig,
  readUserConfig,
} from './payload.ts';
import { type ClaudeRuntime, type HostServices, INLINE_MAX_BYTES, PLUGIN_VERSION } from './types.ts';

const DEFAULT_ORDER = ['autocorrect', 'shortcuts', 'menu', 'rescue', 'phrases', 'history', 'names'] as const;

/** Bounds on session start: the helper is ready in ~4–10 ms and loads config in a few more. */
export const HELPER_READY_MS = 1500;
export const CONFIG_LOAD_MS = 1000;
/**
 * Status copy fits Claude's hint row: at 120 columns in auto mode about 45
 * columns are left after Claude's own parts, and Claude cuts the rest, the
 * command first (the old 83-column fallback lost its `murmo doctor`).
 */
export const HELPER_DOWN_NOTICE = 'Murmo helper stopped; restart Claude Code';
/** The helper is missing, did not start or could not load config: doctor says which. */
export const HELPER_FALLBACK_NOTICE = 'project shortcuts off: run murmo doctor';
/** A Claude build whose plugins can't start a process. */
export const NO_PROCESS_NOTICE = 'project shortcuts off: no process API';

export interface ClaudeSessionOptions extends ClaudeAdapterOptions {
  readonly plugins?: readonly HostPluginSpec[];
  readonly payloadRoot?: string;
  readonly clock?: Clock;
  /** Where installed third-party plugins run; default the session's helper. Tests pass a stand-in. */
  readonly thirdParty?: (clock: Clock) => Executor;
  /** How often the helper re-checks the config files; default `RECHECK_MS`. */
  readonly recheckMs?: number;
}

export interface ClaudeHost {
  readonly adapter: ClaudeAdapter;
  readonly session: Session | undefined;
  readonly helper: HelperHandle | undefined;
  readonly events: EventBroker | undefined;
  readonly alive: boolean;
  /** What this session said: its startup notices (shown until the first send), then the adapter's own. */
  readonly notices: readonly string[];
  start(rt: ClaudeRuntime): Promise<void>;
  bootPacked(input: PackedBoot): Promise<void>;
  dispose(): Promise<void>;
}

export interface PackedBoot {
  readonly payloadRoot: string;
  readonly integrityJson: string;
  readonly tableRaw?: string | { readonly base64: string };
  readonly casePolicyJson?: string;
  readonly userToml?: string;
  readonly cwd: string;
  /** Timers, the helper process and its socket; without them there is no helper and timers never fire. */
  readonly services?: HostServices;
  /** Helper binaries in the payload that exist, in the order to try. */
  readonly helperBinaries?: readonly string[];
  /** `$TMPDIR`, for the helper's socket. */
  readonly tmpdir?: string;
  /** What `murmo plugin` installed (`readPluginSelection`, read through `$.fs`). */
  readonly installed?: InstalledSelection;
  /** Re-reads it while the session runs, so `murmo plugin` changes apply live. */
  readonly selection?: SelectionSource;
}

/** `murmo plugin`'s selection as Claude reads it (`$.fs`). */
export interface SelectionSource {
  /** `plugins.json`'s revision, 0 without one; cheap, read every round. */
  revision(): Promise<number>;
  /** The whole selection, its files checked; read only when the revision moved. */
  read(): Promise<InstalledSelection>;
}

function servicesOf(rt: ClaudeRuntime): HostServices {
  return {
    after: (ms, callback) => rt.clock.after(ms, callback),
    spawn: (argv) => rt.process.spawn({ argv }),
    fetch: (url, init) => rt.http.fetch(url, init),
    repaint: () => rt.ui.invalidate('ui.render'),
    suggest: (text) => rt.prompt.suggest({ text }),
  };
}

function clockOf(services: HostServices | undefined, injected?: Clock): Clock {
  if (injected) return injected;
  if (!services) return createClock({ setTimer: (_callback, _ms) => () => {} });
  return createClock({
    now: () => {
      const perf = (globalThis as { performance?: { now?: () => number } }).performance;
      return typeof perf?.now === 'function' ? perf.now() : Date.now();
    },
    wallTimeMs: () => Date.now(),
    setTimer: (callback, ms) => {
      const handle = services.after(ms, callback);
      return () => handle.cancel();
    },
  });
}

/** The personal file alone: what a session has when the helper can't load config. */
function personalOnly(userText: string | undefined): LoadedSession {
  const parsed = parseUserConfig(userText, 'murmo.toml');
  const user = parsed ? resolveShortcuts(parsed, new Map()) : undefined;
  return { trust: 'none', effective: mergeConfig({ ...(user ? { user } : {}), projectTrusted: false }) };
}

function within<T>(clock: Clock, ms: number, what: string, work: Promise<T>): Promise<T> {
  const late = clock.sleep(ms).then(() => {
    throw new Error(`${what} took over ${ms} ms`);
  });
  return Promise.race([work, late]);
}

interface ConfigBoot {
  readonly services: HostServices | undefined;
  readonly binaries: readonly string[];
  readonly tmpdir: string | undefined;
  readonly userText: string | undefined;
  readonly cwd: string;
  readonly clock: Clock;
  readonly notices: string[];
  readonly watch: HelperWatch;
}

/** A helper that dies mid-session is restarted; one that stays down says so in the status tail. */
function helperWatch(adapter: ClaudeAdapter, services: HostServices | undefined): HelperWatch {
  return {
    onExit: () => adapter.noteHelper(false),
    onRestart: () => adapter.noteHelper(true),
    onGiveUp: () => {
      if (adapter.notices.includes(HELPER_DOWN_NOTICE)) return;
      adapter.notices.push(HELPER_DOWN_NOTICE);
      services?.repaint();
    },
  };
}

/**
 * Starts the helper and loads the session's config through it. Any failure
 * leaves the personal file in charge with one notice: project shortcuts are
 * off, never loaded unchecked.
 */
async function loadConfig(
  boot: ConfigBoot,
): Promise<{ session: LoadedSession; helper?: HelperHandle; stamps?: unknown }> {
  const fallback = (notice: string = HELPER_FALLBACK_NOTICE) => {
    boot.notices.push(notice);
    return { session: personalOnly(boot.userText) };
  };
  if (!boot.services) return fallback(NO_PROCESS_NOTICE);
  if (boot.binaries.length === 0) return fallback();
  let helper: HelperHandle;
  try {
    helper = await superviseHelper(
      boot.services,
      boot.binaries,
      socketDir(boot.tmpdir),
      boot.clock,
      HELPER_READY_MS,
      boot.watch,
    );
  } catch {
    return fallback();
  }
  try {
    const reply = await within(
      boot.clock,
      CONFIG_LOAD_MS,
      'config.load',
      helper.transport().request({ op: 'config.load', cwd: boot.cwd }),
    );
    const session = reply.status === 'ok' ? sessionFromJson(reply.session) : undefined;
    if (!session) return { ...fallback(), helper };
    return { session, helper, stamps: reply.stamps };
  } catch {
    return { ...fallback(), helper };
  }
}

/**
 * Draft rescue through the helper, which owns the draft files: Claude's `$.fs`
 * can't write a 0600 file atomically, list a folder or delete. Requests go to
 * the current helper, so a restarted one takes over. Without a helper (or a
 * project id from it) drafts stay in memory and nothing is offered.
 */
/** The store protocol over the helper's socket. */
function storeTransport(helper: HelperHandle): StoreTransport {
  return {
    request: async (message) => (await helper.transport().request({ ...message })) as unknown as StoreReply,
  };
}

async function rescueOptions(
  helper: HelperHandle | undefined,
  cwd: string,
  clock: Clock,
  services: HostServices | undefined,
): Promise<RescueOptions> {
  const session = newDraftSession('claude');
  const memory = {
    drafts: createMemoryDrafts(),
    identity: { project: '0'.repeat(64), host: 'claude' as const, session },
  };
  if (!helper) return memory;
  const transport = storeTransport(helper);
  const project = await within(clock, CONFIG_LOAD_MS, 'project.id', remoteProjectId(transport, cwd)).catch(
    () => undefined,
  );
  if (!project) return memory;
  const drafts = createRemoteDrafts(() => transport);
  const identity = { project, host: 'claude' as const, session };
  // Looked up before the session starts: a hook can't wait on the helper.
  const offer = await within(
    clock,
    CONFIG_LOAD_MS,
    'drafts.offer',
    findOffer(drafts, identity, clock.wallTimeMs()),
  ).catch(() => undefined);
  // Claude gives plugins no Tab: the offered draft is Claude's own empty-prompt
  // suggestion, which its Tab puts in the box.
  const suggest = services
    ? (text: string) => {
        services.suggest(text).catch(() => undefined);
      }
    : undefined;
  return { drafts, identity, ...(offer ? { offer } : {}), ...(suggest ? { suggest } : {}) };
}

interface ConfigFollow {
  readonly services: HostServices;
  readonly helper: HelperHandle;
  readonly clock: Clock;
  readonly cwd: string;
  /** The load the session started with, and its `config.load` stamps. */
  readonly started: LoadedSession;
  readonly stamps: unknown;
  readonly table: PayloadTable | undefined;
  readonly rescue: RescueOptions;
  readonly session: Session;
  readonly runner: PluginHost;
  readonly everyMs: number | undefined;
  /** The new startup notices, without the boot ones. */
  readonly restate: (notices: readonly string[], short: Readonly<Record<string, string>>) => void;
  /** The config and the built-ins it makes, after each change. */
  readonly rebuilt?: (session: LoadedSession, builtins: readonly HostPluginSpec[]) => void;
}

/**
 * An edited murmo.toml or .murmo.toml, `murmo trust` or `murmo words` applies
 * without restarting Claude. Claude's runtime can't stat a file, so the helper
 * re-checks the last load's files (`config.load` with `since`) while idle; on
 * a change the built-ins it configures reload and the notices follow. A
 * helper that is down or restarting just misses a round.
 */
function followConfig(follow: ConfigFollow): () => void {
  let current = follow.started;
  let stamps = follow.stamps;
  return watchConfig({
    ...(follow.everyMs === undefined ? {} : { everyMs: follow.everyMs }),
    after: (ms, callback) => {
      const handle = follow.services.after(ms, callback);
      return () => handle.cancel();
    },
    check: async () => {
      const reply = await within(
        follow.clock,
        CONFIG_LOAD_MS,
        'config.load',
        follow.helper.transport().request({ op: 'config.load', cwd: follow.cwd, since: stamps }),
      );
      if (reply.status !== 'ok' || reply.unchanged === true) return;
      const next = sessionFromJson(reply.session);
      if (!next) return;
      const previous = current;
      current = next;
      stamps = reply.stamps;
      const rebuilt = builtinsFromConfig(next, follow.table, follow.rescue);
      follow.rebuilt?.(next, rebuilt.specs);
      const changed = new Set(changedBuiltins(previous.effective, next.effective));
      await reloadPlugins(
        follow.session,
        follow.runner,
        rebuilt.specs.filter((spec) => changed.has(spec.id)),
      );
      follow.restate(
        [...restartNotice(restartSettings(follow.started.effective, next.effective)), ...rebuilt.notices],
        rebuilt.short,
      );
    },
  });
}

/**
 * `murmo plugin add`, `enable`, `disable`, `remove` and grant changes apply to
 * a running Claude session: plugins.json's revision is read while idle, and
 * when it moved the session follows the new selection. Claude can't write the
 * acknowledgement the CLI waits on, so the CLI doesn't wait for it.
 */
function followSelection(
  source: SelectionSource,
  services: HostServices,
  started: InstalledSelection,
  options: PluginFollowerOptions,
  everyMs: number | undefined,
): () => void {
  const follower = followPlugins(started, options);
  let seen = started.revision ?? 0;
  return watchConfig({
    ...(everyMs === undefined ? {} : { everyMs }),
    after: (ms, callback) => {
      const handle = services.after(ms, callback);
      return () => handle.cancel();
    },
    check: async () => {
      if ((await source.revision()) === seen) return;
      const next = await source.read();
      await follower.apply(next);
      seen = next.revision ?? seen;
    },
  });
}

function builtinsFromConfig(
  session: LoadedSession,
  table: PayloadTable | undefined,
  rescue: RescueOptions,
): {
  specs: HostPluginSpec[];
  order: string[];
  notices: string[];
  /** Short forms of `notices` for a narrow hint row (`ClaudeAdapter.shortForms`). */
  short: Readonly<Record<string, string>>;
} {
  const config = session.effective;
  const compiled = compileConfigShortcuts(config, { session, asyncEdits: false, inlineMaxBytes: INLINE_MAX_BYTES });

  if (table) {
    provideEnglishPack({
      bytes: table.bytes,
      sha256: table.sha256,
      entries: table.entries,
      lowercaseOnly: table.lowercaseOnly,
    });
  }
  const settings = resolveAutocorrectSettings({
    enabled: config.autocorrect,
    ...(config.language ? { language: config.language } : {}),
    allow: config.protect.join(' '),
  });
  const autocorrect: HostPluginSpec = table
    ? (() => {
        const bundle = englishInlineRules({
          owner: 'autocorrect',
          pack: {
            bytes: table.bytes,
            sha256: table.sha256,
            entries: table.entries,
            lowercaseOnly: table.lowercaseOnly,
          },
          settings,
          vocabulary: config.protect,
        });
        return {
          id: 'autocorrect',
          builtin: true,
          factory: autocorrectFactory,
          settings: { enabled: config.autocorrect },
          inline: [bundle.rules],
          assets: bundle.assets,
        };
      })()
    : { id: 'autocorrect', builtin: true, factory: autocorrectFactory, settings: { enabled: false } };

  const specs: HostPluginSpec[] = [
    autocorrect,
    shortcutsPlugin(compiled, { asyncEdits: false, inlineMaxBytes: INLINE_MAX_BYTES }),
    menuPlugin(compiled, { history: config.historyEnabled === true }),
    rescuePlugin(rescue),
    // One identity for every built-in: this project and session (`rescueOptions`).
    phrasesPlugin({ identity: rescue.identity }, { learn: config.phrasesLearn === true }),
    historyPlugin({ identity: rescue.identity }, { enabled: config.historyEnabled === true }),
    (() => {
      const settings = {
        enabled: config.names?.enabled !== false,
        ...(config.names?.key ? { key: config.names.key } : {}),
      };
      const names = namesPlugin(memoryBackend([]), settings, 'claude');
      return { id: names.id, builtin: true as const, factory: names.factory, settings };
    })(),
  ];
  const disabled = new Set(
    Object.entries(config.plugins)
      .filter(([, table]) => table.enabled === false)
      .map(([id]) => id),
  );
  const enabled = specs.filter((spec) => !disabled.has(spec.id));
  const wanted = config.pluginOrder ?? [...DEFAULT_ORDER];
  const order = wanted.filter((id) => enabled.some((spec) => spec.id === id));
  // Claude's hint row has room for one of Murmo's lines: a draft waiting to be
  // restored says Murmo is on better than "murmo on · …", which hid the offer.
  const hint = rescue.offer === undefined || disabled.has('rescue');
  return {
    specs: enabled,
    order,
    notices: sessionNotices(session, compiled, { hint }),
    short: noticeShortForms(compiled),
  };
}

export function createClaudeHost(options: ClaudeSessionOptions = {}): ClaudeHost {
  let adapter = new ClaudeAdapter(options);
  let session: Session | undefined;
  let helper: HelperHandle | undefined;
  let events: EventBroker | undefined;
  let alive = false;
  let startup: readonly string[] = [];
  let stopWatch = (): void => {};

  /** Starts the idle config re-check when the helper loaded this session's config. */
  const follows = (
    booted: Awaited<ReturnType<typeof loadConfig>>,
    boot: Pick<ConfigFollow, 'clock' | 'cwd' | 'table' | 'rescue' | 'session' | 'runner' | 'rebuilt'> & {
      readonly services: HostServices | undefined;
      /** Boot notices, shown before the config's own, and the installed plugins' after them. */
      readonly notices: readonly string[];
      readonly installed: readonly string[];
    },
  ): (() => void) => {
    if (options.plugins || !boot.services || !booted.helper || booted.stamps === undefined) return () => {};
    const { notices, installed, services, ...rest } = boot;
    return followConfig({
      ...rest,
      services,
      helper: booted.helper,
      started: booted.session,
      stamps: booted.stamps,
      everyMs: options.recheckMs,
      restate: (next, short) => {
        adapter.shortForms(short);
        startup = [...notices, ...next, ...installed];
        boot.session.restateNotices(startup);
      },
    });
  };

  return {
    get adapter() {
      return adapter;
    },
    get session() {
      return session;
    },
    get helper() {
      return helper;
    },
    get events() {
      return events;
    },
    get alive() {
      return alive;
    },
    get notices() {
      return [...startup, ...adapter.notices];
    },
    async start(rt: ClaudeRuntime) {
      adapter = new ClaudeAdapter(options, rt);
      const services = servicesOf(rt);
      const clock = clockOf(services, options.clock);
      await adapter.ready();
      const payload = await locatePayload(rt, options.payloadRoot);
      const notices: string[] = payload?.notice ? [payload.notice] : [];
      const cwd = await rt.session.cwd();
      const userText = await readUserConfig(rt);
      const booted = options.plugins
        ? { session: personalOnly(userText) }
        : await loadConfig({
            services,
            binaries: payload && !payload.notice ? await helperPaths(rt, payload) : [],
            tmpdir: await rt.env.get('TMPDIR'),
            userText,
            cwd,
            clock,
            notices,
            watch: helperWatch(adapter, services),
          });
      helper = booted.helper;
      adapter.noteHelper(helper !== undefined);
      const config = booted.session.effective;
      // Built-ins (inline teh→the) run in-process; the helper serves config and third-party plugins.
      const executor: Executor = createInProcessExecutor({ clock });
      const table = payload ? await loadTable(rt, payload) : undefined;
      const rescue = await rescueOptions(helper, cwd, clock, services);
      const loaded = options.plugins
        ? { specs: [...options.plugins], order: options.plugins.map((spec) => spec.id), notices: [], short: {} }
        : builtinsFromConfig(booted.session, table, rescue);
      adapter.shortForms(loaded.short);
      startup = [...notices, ...loaded.notices];
      const runner = createPluginHost({
        specs: loaded.specs,
        executor,
        storage: createMemoryStorage(),
        projectFiles: createMemoryProjectFiles({ root: cwd }),
      });
      session = createSession({
        adapter,
        runner,
        order: loaded.order,
        clock,
        keyBursts: false,
        guardPolicy: 'managed',
        notices: startup,
        notify: (message) => {
          adapter.notices.push(message);
        },
      });
      await session.ready;
      stopWatch = follows(booted, { services, clock, cwd, table, rescue, session, runner, notices, installed: [] });
      const caps = session.caps();
      if (config.events && caps) {
        const enabled = new Set(
          ['audit', 'tool-guard', 'turn-context', 'next-ghost'].filter((id) => config.plugins[id]?.enabled === true),
        );
        events = createClaudeBroker({
          clock,
          hostVersion: PLUGIN_VERSION,
          mods: true,
          enabled,
          audit: (line) => {
            adapter.notices.push(line.trim());
          },
          draft: () => session?.draft() ?? { text: '', cursor: 0, version: 0, certainty: 'unknown', typedSpans: [] },
          state: () => ({
            mode: 'prose',
            popup: null,
            dialog: false,
            busy: false,
            editorMode: 'insert',
            history: false,
          }),
          sessionId: () => 'claude',
          hostCaps: caps,
          ghost: {
            apply: async (_id, text, version) => {
              const box = await rt.prompt.read();
              if (box.text !== '') return { status: 'denied' as const, reason: 'prompt not empty' };
              const suggest = (
                rt as ClaudeRuntime & {
                  prompt: ClaudeRuntime['prompt'] & { suggest?: (t: string) => Promise<{ isShown?: boolean }> };
                }
              ).prompt.suggest;
              if (typeof suggest === 'function') {
                const shown = await suggest(text);
                return { status: 'applied' as const, reason: shown?.isShown ? 'suggest-ack' : 'suggest' };
              }
              void version;
              return { status: 'unsupported' as const, reason: 'rt.prompt.suggest missing' };
            },
          },
        }).broker;
      }
      alive = true;
    },
    async bootPacked(input: PackedBoot) {
      const repaint = input.services?.repaint;
      adapter = new ClaudeAdapter({ ...options, skipProbes: true, ...(repaint ? { repaint } : {}) });
      const clock = clockOf(input.services, options.clock);
      const notices: string[] = [];
      let payload: LocatedPayload | undefined;
      try {
        const integrity = JSON.parse(input.integrityJson) as IntegrityFile;
        if (integrity?.version === PLUGIN_VERSION) payload = { root: input.payloadRoot, integrity };
        else if (integrity?.version)
          notices.push(`payload version ${integrity.version} does not match plugin ${PLUGIN_VERSION}`);
      } catch {
        payload = undefined;
      }
      const booted = options.plugins
        ? { session: personalOnly(input.userToml) }
        : await loadConfig({
            services: input.services,
            binaries: payload ? (input.helperBinaries ?? []) : [],
            tmpdir: input.tmpdir,
            userText: input.userToml,
            cwd: input.cwd,
            clock,
            notices,
            watch: helperWatch(adapter, input.services),
          });
      helper = booted.helper;
      adapter.noteHelper(helper !== undefined);
      let table: PayloadTable | undefined;
      if (payload && input.tableRaw) {
        const bytes = bytesOf(input.tableRaw);
        const mapped = mapTable(bytes);
        let lowercaseOnly: string[] = [];
        if (input.casePolicyJson) {
          try {
            const json = JSON.parse(input.casePolicyJson) as { lowercaseOnly?: unknown };
            if (Array.isArray(json.lowercaseOnly))
              lowercaseOnly = json.lowercaseOnly.filter((w): w is string => typeof w === 'string');
          } catch {
            lowercaseOnly = [];
          }
        }
        table = { bytes, sha256: '', entries: mapped.entries, lowercaseOnly };
      }
      // Built-ins run in-process; installed plugins only ever in the helper, through
      // whichever helper process is current when they load.
      const executor = createRoutedExecutor({
        trusted: createInProcessExecutor({ clock }),
        isolated: () => {
          if (options.thirdParty) return options.thirdParty(clock);
          if (!helper) throw new Error('the Murmo helper is not running (murmo doctor)');
          return isolatedFrom(helper, clock);
        },
      });
      const rescue = await rescueOptions(helper, input.cwd, clock, input.services);
      const builtins = options.plugins
        ? { specs: [...options.plugins], order: options.plugins.map((spec) => spec.id), notices: [], short: {} }
        : builtinsFromConfig(booted.session, table, rescue);
      const loaded = withInstalled(
        { specs: builtins.specs, order: builtins.order, grants: {} },
        options.plugins ? EMPTY_SELECTION : (input.installed ?? EMPTY_SELECTION),
        booted.session.effective.plugins,
      );
      adapter.shortForms(builtins.short);
      startup = [...notices, ...builtins.notices, ...loaded.notices];
      const runner = createPluginHost({
        specs: loaded.specs,
        executor,
        grants: loaded.grants,
        // The namespaces `murmo plugin` snapshots, migrates and rolls back,
        // through the helper; without one they last the session.
        ...(helper ? { broker: createRemoteStore(storeTransport(helper)) } : { storage: createMemoryStorage() }),
        projectFiles: createMemoryProjectFiles({ root: input.cwd }),
      });
      session = createSession({
        adapter,
        runner,
        order: loaded.order,
        clock,
        keyBursts: false,
        guardPolicy: 'managed',
        notices: startup,
        notify: (message) => {
          adapter.notices.push(message);
        },
      });
      await session.ready;
      // What the session runs now: config edits change it, the plugin follower reads it.
      const live = { builtins: builtins.specs as readonly HostPluginSpec[], tables: booted.session.effective.plugins };
      const stopConfig = follows(booted, {
        services: input.services,
        clock,
        cwd: input.cwd,
        table,
        rescue,
        session,
        runner,
        notices,
        installed: loaded.notices,
        rebuilt: (next, specs) => {
          live.builtins = specs;
          live.tables = next.effective.plugins;
        },
      });
      const stopPlugins =
        options.plugins || !input.services || !input.selection
          ? () => {}
          : followSelection(
              input.selection,
              input.services,
              input.installed ?? EMPTY_SELECTION,
              {
                session,
                host: runner,
                builtins: () => live.builtins,
                tables: () => live.tables,
              },
              options.recheckMs,
            );
      stopWatch = () => {
        stopConfig();
        stopPlugins();
      };
      alive = true;
    },
    async dispose() {
      stopWatch();
      alive = false;
      events = undefined;
      await session?.dispose();
      session = undefined;
      await helper?.dispose();
      helper = undefined;
    },
  };
}

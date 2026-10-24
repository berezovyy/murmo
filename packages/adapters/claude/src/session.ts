// Wire the core session, built-in plugins, config and the helper.
//
// Config comes from the helper's `config.load` (phase 14): Claude's runtime
// has no lstat, realpath or O_NOFOLLOW, so only the helper can check a
// project `.murmo.toml` against its approval the way Pi and OpenCode do. The
// helper starts in a few milliseconds; while it can't answer, the session runs
// on the personal file alone and says why project shortcuts are off.

import type { Clock } from '@murmo/api';
import type { Executor } from '@murmo/api/adapter';
import { type LoadedSession, mergeConfig, resolveShortcuts, sessionFromJson } from '@murmo/config';
import {
  createMemoryProjectFiles,
  createMemoryStorage,
  createPluginHost,
  createSession,
  type EventBroker,
  type HostPluginSpec,
  type Session,
} from '@murmo/core';
import { createClock, createInProcessExecutor } from '@murmo/executor';
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
import { compileConfigShortcuts, menuPlugin, sessionNotices, shortcutsPlugin } from '@murmo/plugin-shortcuts';
import {
  createMemoryDrafts,
  createRemoteDrafts,
  newDraftSession,
  remoteProjectId,
  type StoreReply,
  type StoreTransport,
} from '@murmo/store';
import { ClaudeAdapter, type ClaudeAdapterOptions } from './adapter.ts';
import { bytesOf } from './decode.ts';
import { createClaudeBroker } from './events.ts';
import { type HelperHandle, type HelperWatch, socketDir, superviseHelper } from './helper.ts';
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
export const HELPER_DOWN_NOTICE = 'Murmo helper stopped and did not restart; restart Claude Code (murmo doctor)';

export interface ClaudeSessionOptions extends ClaudeAdapterOptions {
  readonly plugins?: readonly HostPluginSpec[];
  readonly payloadRoot?: string;
  readonly clock?: Clock;
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
}

function servicesOf(rt: ClaudeRuntime): HostServices {
  return {
    after: (ms, callback) => rt.clock.after(ms, callback),
    spawn: (argv) => rt.process.spawn({ argv }),
    fetch: (url, init) => rt.http.fetch(url, init),
    repaint: () => rt.ui.invalidate('ui.render'),
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
async function loadConfig(boot: ConfigBoot): Promise<{ session: LoadedSession; helper?: HelperHandle }> {
  const fallback = (why: string) => {
    boot.notices.push(`project shortcuts off: ${why}`);
    return { session: personalOnly(boot.userText) };
  };
  if (!boot.services) return fallback('this Claude build gives plugins no process API');
  if (boot.binaries.length === 0) return fallback('the Murmo helper is missing from this install (murmo doctor)');
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
  } catch (error) {
    return fallback(`the Murmo helper did not start (${error instanceof Error ? error.message : String(error)})`);
  }
  try {
    const reply = await within(
      boot.clock,
      CONFIG_LOAD_MS,
      'config.load',
      helper.transport().request({ op: 'config.load', cwd: boot.cwd }),
    );
    const session = reply.status === 'ok' ? sessionFromJson(reply.session) : undefined;
    if (!session) {
      const why = typeof reply.error === 'string' ? reply.error : 'unreadable reply';
      return { ...fallback(`the Murmo helper could not load config (${why})`), helper };
    }
    return { session, helper };
  } catch (error) {
    return {
      ...fallback(`the Murmo helper could not load config (${error instanceof Error ? error.message : String(error)})`),
      helper,
    };
  }
}

/**
 * Draft rescue through the helper, which owns the draft files: Claude's `$.fs`
 * can't write a 0600 file atomically, list a folder or delete. Requests go to
 * the current helper, so a restarted one takes over. Without a helper (or a
 * project id from it) drafts stay in memory and nothing is offered.
 */
async function rescueOptions(helper: HelperHandle | undefined, cwd: string, clock: Clock): Promise<RescueOptions> {
  const session = newDraftSession('claude');
  const memory = {
    drafts: createMemoryDrafts(),
    identity: { project: '0'.repeat(64), host: 'claude' as const, session },
  };
  if (!helper) return memory;
  const transport: StoreTransport = {
    request: async (message) => (await helper.transport().request({ ...message })) as unknown as StoreReply,
  };
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
  return { drafts, identity, ...(offer ? { offer } : {}) };
}

function builtinsFromConfig(
  session: LoadedSession,
  cwd: string,
  table: PayloadTable | undefined,
  rescue: RescueOptions,
): {
  specs: HostPluginSpec[];
  order: string[];
  notices: string[];
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

  const project = `${cwd.replace(/[^a-zA-Z0-9]/g, '')}0000000000000000`.slice(0, 16);
  const specs: HostPluginSpec[] = [
    autocorrect,
    shortcutsPlugin(compiled, { asyncEdits: false, inlineMaxBytes: INLINE_MAX_BYTES }),
    menuPlugin(compiled, { history: config.historyEnabled === true }),
    rescuePlugin(rescue),
    phrasesPlugin(
      { identity: { project, host: 'claude', session: PLUGIN_VERSION } },
      { learn: config.phrasesLearn === true },
    ),
    historyPlugin(
      { identity: { project, host: 'claude', session: PLUGIN_VERSION } },
      { enabled: config.historyEnabled === true },
    ),
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
  return { specs: enabled, order, notices: sessionNotices(session, compiled) };
}

export function createClaudeHost(options: ClaudeSessionOptions = {}): ClaudeHost {
  let adapter = new ClaudeAdapter(options);
  let session: Session | undefined;
  let helper: HelperHandle | undefined;
  let events: EventBroker | undefined;
  let alive = false;
  let startup: readonly string[] = [];

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
      const loaded = options.plugins
        ? { specs: [...options.plugins], order: options.plugins.map((spec) => spec.id), notices: [] }
        : builtinsFromConfig(
            booted.session,
            cwd,
            payload ? await loadTable(rt, payload) : undefined,
            await rescueOptions(helper, cwd, clock),
          );
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
      const executor: Executor = createInProcessExecutor({ clock });
      const loaded = options.plugins
        ? { specs: [...options.plugins], order: options.plugins.map((spec) => spec.id), notices: [] }
        : builtinsFromConfig(booted.session, input.cwd, table, await rescueOptions(helper, input.cwd, clock));
      startup = [...notices, ...loaded.notices];
      const runner = createPluginHost({
        specs: loaded.specs,
        executor,
        storage: createMemoryStorage(),
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
      alive = true;
    },
    async dispose() {
      alive = false;
      events = undefined;
      await session?.dispose();
      session = undefined;
      await helper?.dispose();
      helper = undefined;
    },
  };
}

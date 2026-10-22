// Wire the core session, built-in plugins, user config and optional helper.

import type { Clock } from '@murmo/api';
import type { Executor } from '@murmo/api/adapter';
import { mergeConfig, resolveShortcuts } from '@murmo/config';
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
import { rescuePlugin } from '@murmo/plugin-rescue';
import { compileShortcuts, menuPlugin, shortcutsPlugin } from '@murmo/plugin-shortcuts';
import { createMemoryDrafts } from '@murmo/store';
import { ClaudeAdapter, type ClaudeAdapterOptions } from './adapter.ts';
import { bytesOf } from './decode.ts';
import { createClaudeBroker } from './events.ts';
import { type HelperHandle, spawnHelper } from './helper.ts';
import {
  helperPath,
  type IntegrityFile,
  type LocatedPayload,
  loadTable,
  locatePayload,
  type PayloadTable,
  parseUserConfig,
  readUserConfig,
} from './payload.ts';
import { type ClaudeRuntime, INLINE_MAX_BYTES, PLUGIN_VERSION } from './types.ts';

const DEFAULT_ORDER = ['autocorrect', 'shortcuts', 'menu', 'rescue', 'phrases', 'history', 'names'] as const;

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
}

function clockOf(rt: ClaudeRuntime, injected?: Clock): Clock {
  if (injected) return injected;
  return createClock({
    now: () => {
      const perf = (globalThis as { performance?: { now?: () => number } }).performance;
      return typeof perf?.now === 'function' ? perf.now() : Date.now();
    },
    wallTimeMs: () => Date.now(),
    setTimer: (callback, ms) => {
      const handle = rt.clock.after(ms, callback);
      return () => handle.cancel();
    },
  });
}

function builtinsFromConfig(
  adapter: ClaudeAdapter,
  userText: string | undefined,
  cwd: string,
  table: PayloadTable | undefined,
): {
  specs: HostPluginSpec[];
  order: string[];
} {
  const parsed = parseUserConfig(userText, 'murmo.toml');
  const user = parsed ? resolveShortcuts(parsed, new Map()) : undefined;
  const config = mergeConfig({ ...(user ? { user } : {}), projectTrusted: false });
  const compiled = compileShortcuts({
    replacements: config.replacements.map((entry) => ({
      shortcut: entry.shortcut,
      text: entry.text,
      origin: entry.origin,
    })),
    overrides: config.overrides,
    asyncEdits: false,
    inlineMaxBytes: INLINE_MAX_BYTES,
  });
  for (const notice of compiled.notices) adapter.notices.push(notice.text);

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
    rescuePlugin({
      drafts: createMemoryDrafts(),
      identity: { project, host: 'claude', session: PLUGIN_VERSION },
    }),
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
  return { specs: enabled, order };
}

async function builtIns(
  rt: ClaudeRuntime,
  adapter: ClaudeAdapter,
  payload: LocatedPayload | undefined,
): Promise<{
  specs: HostPluginSpec[];
  order: string[];
}> {
  const userText = await readUserConfig(rt);
  const table = payload ? await loadTable(rt, payload) : undefined;
  const cwd = await rt.session.cwd();
  return builtinsFromConfig(adapter, userText, cwd, table);
}

function packedClock(injected?: Clock): Clock {
  if (injected) return injected;
  return createClock({
    setTimer: (_callback, _ms) => () => {},
  });
}

export function createClaudeHost(options: ClaudeSessionOptions = {}): ClaudeHost {
  let adapter = new ClaudeAdapter(options);
  let session: Session | undefined;
  let helper: HelperHandle | undefined;
  let events: EventBroker | undefined;
  let alive = false;

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
      return adapter.notices;
    },
    async start(rt: ClaudeRuntime) {
      adapter = new ClaudeAdapter(options, rt);
      const clock = clockOf(rt, options.clock);
      await adapter.ready();
      const payload = await locatePayload(rt, options.payloadRoot);
      if (payload?.notice) adapter.notices.push(payload.notice);
      // Built-ins (inline teh→the) run in-process. Waiting for the helper here
      // left host.alive false through the harness ready_quiet window (4 s vs 1 s).
      const executor: Executor = createInProcessExecutor({ clock });
      const loaded = options.plugins
        ? { specs: [...options.plugins], order: options.plugins.map((spec) => spec.id) }
        : await builtIns(rt, adapter, payload);
      const runner = createPluginHost({
        specs: loaded.specs,
        executor,
        storage: createMemoryStorage(),
        projectFiles: createMemoryProjectFiles({ root: await rt.session.cwd() }),
      });
      session = createSession({
        adapter,
        runner,
        order: loaded.order,
        clock,
        keyBursts: false,
        guardPolicy: 'managed',
        notify: (message) => {
          adapter.notices.push(message);
        },
      });
      await session.ready;
      if (payload && !payload.notice) {
        const binary = await helperPath(rt, payload);
        if (binary) {
          void spawnHelper(rt, binary, clock).then(
            (handle) => {
              helper = handle;
              adapter.noteHelper(true);
            },
            (error: unknown) => {
              adapter.notices.push(`helper unavailable: ${error instanceof Error ? error.message : String(error)}`);
              adapter.noteHelper(false);
            },
          );
        }
      }
      const userText = await readUserConfig(rt);
      const parsed = parseUserConfig(userText, 'murmo.toml');
      const user = parsed ? resolveShortcuts(parsed, new Map()) : undefined;
      const config = mergeConfig({ ...(user ? { user } : {}), projectTrusted: false });
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
      adapter = new ClaudeAdapter({ ...options, skipProbes: true });
      const clock = packedClock(options.clock);
      let payload: LocatedPayload | undefined;
      try {
        const integrity = JSON.parse(input.integrityJson) as IntegrityFile;
        if (integrity?.version === PLUGIN_VERSION) payload = { root: input.payloadRoot, integrity };
        else if (integrity?.version)
          adapter.notices.push(`payload version ${integrity.version} does not match plugin ${PLUGIN_VERSION}`);
      } catch {
        payload = undefined;
      }
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
        ? { specs: [...options.plugins], order: options.plugins.map((spec) => spec.id) }
        : builtinsFromConfig(adapter, input.userToml, input.cwd, table);
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

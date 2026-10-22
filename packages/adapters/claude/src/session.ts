// Wire the core session, built-in plugins, user config and optional helper.

import type { Clock } from '@murmo/api';
import type { Executor, StorageBackend } from '@murmo/api/adapter';
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
import { createClaudeBroker } from './events.ts';
import { type HelperHandle, isolatedFrom, spawnHelper } from './helper.ts';
import {
  helperPath,
  type LocatedPayload,
  loadTable,
  locatePayload,
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
  start($: ClaudeRuntime): Promise<void>;
  dispose(): Promise<void>;
}

function clockOf($: ClaudeRuntime, injected?: Clock): Clock {
  if (injected) return injected;
  return createClock({
    now: () => {
      const perf = (globalThis as { performance?: { now?: () => number } }).performance;
      return typeof perf?.now === 'function' ? perf.now() : Date.now();
    },
    wallTimeMs: () => Date.now(),
    setTimer: (callback, ms) => {
      const handle = $.clock.after(ms, callback);
      return () => handle.cancel();
    },
  });
}

function storageOverHelper(handle: HelperHandle): StorageBackend {
  return {
    async load(namespace) {
      const reply = await handle.transport().request({ op: 'storage.get', plugin: namespace, key: '__doc__' });
      return typeof reply.value === 'string' ? reply.value : '{}';
    },
    async save(namespace, json) {
      await handle.transport().request({ op: 'storage.set', plugin: namespace, key: '__doc__', value: json });
    },
  };
}

async function builtIns(
  $: ClaudeRuntime,
  adapter: ClaudeAdapter,
  payload: LocatedPayload | undefined,
): Promise<{
  specs: HostPluginSpec[];
  order: string[];
}> {
  const userText = await readUserConfig($);
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

  const table = payload ? await loadTable($, payload) : undefined;
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

  const cwd = await $.session.cwd();
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
    async start($: ClaudeRuntime) {
      adapter = new ClaudeAdapter(options, $);
      const clock = clockOf($, options.clock);
      await adapter.ready();
      const payload = await locatePayload($, options.payloadRoot);
      if (payload?.notice) adapter.notices.push(payload.notice);
      let executor: Executor = createInProcessExecutor({ clock });
      if (payload && !payload.notice) {
        const binary = await helperPath($, payload);
        if (binary) {
          try {
            helper = await spawnHelper($, binary, clock);
            adapter.noteHelper(true);
            executor = isolatedFrom(helper, clock);
          } catch (error) {
            adapter.notices.push(`helper unavailable: ${error instanceof Error ? error.message : String(error)}`);
            adapter.noteHelper(false);
            helper = undefined;
            executor = createInProcessExecutor({ clock });
          }
        }
      }
      const loaded = options.plugins
        ? { specs: [...options.plugins], order: options.plugins.map((spec) => spec.id) }
        : await builtIns($, adapter, payload);
      const runner = createPluginHost({
        specs: loaded.specs,
        executor,
        storage: helper ? storageOverHelper(helper) : createMemoryStorage(),
        projectFiles: createMemoryProjectFiles({ root: await $.session.cwd() }),
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
      const userText = await readUserConfig($);
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
              const box = await $.prompt.read();
              if (box.text !== '') return { status: 'denied' as const, reason: 'prompt not empty' };
              const suggest = (
                $ as ClaudeRuntime & {
                  prompt: ClaudeRuntime['prompt'] & { suggest?: (t: string) => Promise<{ isShown?: boolean }> };
                }
              ).prompt.suggest;
              if (typeof suggest === 'function') {
                const shown = await suggest(text);
                return { status: 'applied' as const, reason: shown?.isShown ? 'suggest-ack' : 'suggest' };
              }
              void version;
              return { status: 'unsupported' as const, reason: '$.prompt.suggest missing' };
            },
          },
        }).broker;
      }
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

// Built-in specs the Pi loader registers. Literal shortcut settings become
// inline rules here (r14 H1 left `;r14␠` literal because the installer never
// did this). Autocorrect stays opt-in from merged config.

import type { EffectiveConfig, LoadedSession } from '@murmo/config';
import type { HostPluginSpec } from '@murmo/core';
import { autocorrectSpec } from '@murmo/plugin-autocorrect';
import { findShippedEnglishDir, loadBuiltPack } from '@murmo/plugin-autocorrect/node/from-dir';
import { historyPlugin } from '@murmo/plugin-history';
import { persistEvents as persistHistory } from '@murmo/plugin-history/node';
import { memoryBackend, namesPlugin } from '@murmo/plugin-names';
import { phrasesPlugin } from '@murmo/plugin-phrases';
import { persistEvents } from '@murmo/plugin-phrases/node';
import { rescuePlugin } from '@murmo/plugin-rescue';
import {
  compileConfigShortcuts,
  menuPlugin,
  SAMPLE_SHORTCUTS,
  sessionNotices,
  shortcutRecords,
  shortcutsPlugin,
} from '@murmo/plugin-shortcuts';
import type { DraftDocument, DraftIdentity, Drafts } from '@murmo/store';
import type { Store } from '@murmo/store/node';

export const DEFAULT_ORDER = ['autocorrect', 'shortcuts', 'menu', 'rescue', 'phrases', 'history', 'names'] as const;

export interface BuiltinLoad {
  readonly specs: HostPluginSpec[];
  readonly order: readonly string[];
  /** The session's startup notices, most important first (core `SessionOptions.notices`). */
  readonly notices: readonly string[];
}

export interface BuiltinOptions {
  readonly config?: EffectiveConfig;
  /** Project trust and summary of the load `config` came from. */
  readonly session?: Pick<LoadedSession, 'trust' | 'project'>;
  readonly drafts?: Drafts;
  readonly identity?: DraftIdentity;
  /** The crashed draft found at start, offered on the empty prompt. */
  readonly offer?: DraftDocument;
  readonly store?: Store;
  readonly cwd?: string;
  /** Tests pass a subset; the extension loads every built-in. */
  readonly ids?: readonly string[];
  /** The session's current `private` flag, for plugins a config reload keeps; default `config.private`. */
  readonly isPrivate?: () => boolean;
  /** Read the shipped English pack (default). A config reload reuses the one already loaded. */
  readonly loadLanguagePack?: boolean;
}

export function loadBuiltins(options: BuiltinOptions = {}): BuiltinLoad {
  const notices: string[] = [];
  const config = options.config;
  const compiled = compileConfigShortcuts(
    config ?? { replacements: shortcutRecords(SAMPLE_SHORTCUTS), overrides: [] },
    {
      ...(options.session ? { session: options.session } : {}),
      asyncEdits: true,
    },
  );

  const ids = new Set(options.ids ?? DEFAULT_ORDER);
  const specs: HostPluginSpec[] = [];

  if (ids.has('autocorrect') && options.loadLanguagePack !== false) {
    try {
      const dir = findShippedEnglishDir();
      if (dir) loadBuiltPack(dir);
    } catch (error) {
      notices.push(`English pack: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (ids.has('autocorrect')) {
    const settings = {
      enabled: config?.autocorrect === true,
      language: config?.language ?? 'en',
      allow: (config?.protect ?? []).join(' '),
    };
    specs.push(autocorrectSpec('autocorrect', settings, config?.protect ?? []));
  }

  if (ids.has('shortcuts')) {
    specs.push(shortcutsPlugin(compiled, { asyncEdits: true }));
  }

  if (ids.has('menu')) {
    const historyOn = config?.historyEnabled === true;
    const menu = menuPlugin(compiled, { history: historyOn });
    specs.push({ id: menu.id, builtin: true, factory: menu.factory });
  }

  if (ids.has('rescue') && options.drafts && options.identity) {
    const offer = options.offer;
    specs.push(
      rescuePlugin({
        drafts: options.drafts,
        identity: options.identity,
        isPrivate: async () => (options.isPrivate ? options.isPrivate() : config?.private === true),
        ...(offer ? { offer } : {}),
      }),
    );
  }

  if (ids.has('phrases')) {
    const identity = options.identity;
    const store = options.store;
    specs.push(
      phrasesPlugin(
        {
          ...(identity ? { identity: { project: identity.project, host: 'pi', session: identity.session } } : {}),
          isPrivate: async () => config?.private === true,
          ...(store && identity ? { persist: (events) => void persistEvents(store, identity.session, events) } : {}),
        },
        { learn: config?.phrasesLearn === true },
      ),
    );
  }

  if (ids.has('names')) {
    const settings = {
      enabled: config?.names?.enabled !== false,
      ...(config?.names?.key ? { key: config.names.key } : {}),
    };
    const names = namesPlugin(memoryBackend([]), settings, 'pi');
    specs.push({ id: names.id, builtin: true, factory: names.factory, settings });
  }

  if (ids.has('history')) {
    const identity = options.identity;
    const store = options.store;
    const historyOn = config?.historyEnabled === true;
    specs.push(
      historyPlugin(
        {
          ...(identity ? { identity: { project: identity.project, host: 'pi', session: identity.session } } : {}),
          isPrivate: async () => config?.private === true,
          ...(store && identity ? { persist: (events) => void persistHistory(store, identity.session, events) } : {}),
        },
        { enabled: historyOn },
      ),
    );
  }

  const configured = config?.pluginOrder;
  const specIds = specs.map((spec) => spec.id);
  const order =
    configured && configured.length === specIds.length && specIds.every((id) => configured.includes(id))
      ? configured
      : specIds;
  const startup = config
    ? sessionNotices(
        { effective: config, ...(options.session?.project ? { project: options.session.project } : {}) },
        compiled,
      )
    : compiled.notices.map((notice) => notice.text);
  return { specs, order, notices: [...notices, ...startup] };
}

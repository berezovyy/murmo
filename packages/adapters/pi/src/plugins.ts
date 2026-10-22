// Built-in specs the Pi loader registers. Literal shortcut settings become
// inline rules here (r14 H1 left `;r14␠` literal because the installer never
// did this). Autocorrect stays opt-in from merged config.

import type { EffectiveConfig } from '@murmo/config';
import type { HostPluginSpec } from '@murmo/core';
import { autocorrectSpec } from '@murmo/plugin-autocorrect';
import { findShippedEnglishDir, loadBuiltPack } from '@murmo/plugin-autocorrect/node/from-dir';
import { phrasesPlugin } from '@murmo/plugin-phrases';
import { persistEvents } from '@murmo/plugin-phrases/node';
import { rescuePlugin } from '@murmo/plugin-rescue';
import { compileShortcuts, menuPlugin, SAMPLE_SHORTCUTS, shortcutsPlugin } from '@murmo/plugin-shortcuts';
import type { DraftIdentity, Drafts } from '@murmo/store';
import type { Store } from '@murmo/store/node';

export const DEFAULT_ORDER = ['autocorrect', 'shortcuts', 'menu', 'rescue', 'phrases'] as const;

export interface BuiltinLoad {
  readonly specs: HostPluginSpec[];
  readonly order: readonly string[];
  readonly notices: readonly string[];
}

export interface BuiltinOptions {
  readonly config?: EffectiveConfig;
  readonly drafts?: Drafts;
  readonly identity?: DraftIdentity;
  readonly store?: Store;
  readonly cwd?: string;
  /** Tests pass a subset; the extension loads every built-in. */
  readonly ids?: readonly string[];
}

export function loadBuiltins(options: BuiltinOptions = {}): BuiltinLoad {
  const notices: string[] = [];
  const config = options.config;
  const replacements =
    config?.replacements ??
    Object.entries(SAMPLE_SHORTCUTS).map(([shortcut, text]) => ({
      shortcut,
      text,
      origin: 'user' as const,
    }));
  const compiled = compileShortcuts({
    replacements: replacements.map((entry) => ({
      shortcut: entry.shortcut,
      text: entry.text,
      origin: entry.origin === 'project' ? ('project' as const) : ('user' as const),
    })),
    ...(config?.overrides ? { overrides: config.overrides } : {}),
    trust: 'none',
    asyncEdits: true,
  });
  for (const notice of compiled.notices) notices.push(notice.text);

  const ids = new Set(options.ids ?? DEFAULT_ORDER);
  const specs: HostPluginSpec[] = [];

  if (ids.has('autocorrect')) {
    try {
      const dir = findShippedEnglishDir();
      if (dir) loadBuiltPack(dir);
    } catch (error) {
      notices.push(`English pack: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    const menu = menuPlugin(compiled);
    specs.push({ id: menu.id, builtin: true, factory: menu.factory });
  }

  if (ids.has('rescue') && options.drafts && options.identity) {
    specs.push(
      rescuePlugin({
        drafts: options.drafts,
        identity: options.identity,
        isPrivate: async () => config?.private === true,
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

  const configured = config?.pluginOrder;
  const specIds = specs.map((spec) => spec.id);
  const order =
    configured && configured.length === specIds.length && specIds.every((id) => configured.includes(id))
      ? configured
      : specIds;
  return { specs, order, notices };
}

// The direct hook runner: calls trusted plugin factories in-process, so the
// core can be tested before the executors exist. It is not an executor: no
// deadlines, no CPU or memory limits, no grants (declared permissions count as
// granted, as in the prototype), storage in memory and no project broker.
// Phase 09's executors replace it behind the same HookRunner seam.
//
// What it does keep from the contract: hooks never run inside the caller's
// stack, a cancelled call never starts and its late result is dropped, and a
// plugin's context holds snapshots only, with the typed-only view for
// `draft:read` (@murmo/provenance `projectTyped`).

import type {
  Change,
  Clock,
  Draft,
  InputOriginEvidence,
  Permission,
  Plugin,
  PluginContext,
  PluginFactory,
  PluginHook,
  PluginStorage,
  StorageResult,
} from '@murmo/api';
import type { InlineRules } from '@murmo/api/adapter';
import { HOOKS, type PluginDescriptor } from '@murmo/api/adapter';
import { projectTyped } from '@murmo/provenance';
import type { HookCall, HookRunner, LoadedPlugin, RunnerHealth } from '../hooks.ts';
import { uniquePluginIds } from '../order.ts';
import { CancelledError } from './clock.ts';

export interface DirectPluginSpec {
  readonly id: string;
  readonly builtin: boolean;
  readonly factory: PluginFactory;
  readonly settings?: Readonly<Record<string, unknown>>;
  /** Built-in inline rule sets (phase 07). Ignored, then refused, on third-party specs. */
  readonly inline?: readonly InlineRules[];
  readonly assets?: Readonly<Record<string, ArrayBuffer>>;
}

export interface DirectRunnerOptions {
  readonly plugins: readonly DirectPluginSpec[];
  readonly clock: Clock;
  /** Override reported executor health (the honest-health case: down while the session is still ready). */
  readonly health?: RunnerHealth;
}

export interface DirectRunner extends HookRunner {
  /** Each plugin's stored values, as JSON. */
  storage(): Readonly<Record<string, string>>;
}

const hookNames = Object.keys(HOOKS) as PluginHook[];

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

const emptyDraft: Draft = { text: '', cursor: 0, version: -1, certainty: 'unknown', typedSpans: [] };

function fault(code: 'exception', message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function descriptorOf(id: string, plugin: Plugin): PluginDescriptor {
  return {
    id,
    name: String(plugin.name),
    version: String(plugin.version),
    permissions: [...(plugin.permissions ?? [])],
    guard: plugin.guard === true,
    keys: clone(plugin.keys ?? []),
    actions: [...(plugin.actions ?? [])],
    hooks: hookNames.filter((hook) => typeof plugin[hook] === 'function'),
  };
}

/** What a plugin with these permissions may see of a draft. */
export function draftView(draft: Draft, permissions: readonly Permission[], evidence: InputOriginEvidence): Draft {
  if (permissions.includes('draft:read:full')) return draft;
  if (!permissions.includes('draft:read')) return emptyDraft;
  return projectTyped(draft, evidence);
}

/** The change as a typed-only reader sees it: masked drafts and one whole-draft delta, so no pasted text leaks. */
export function changeView(change: Change, permissions: readonly Permission[], evidence: InputOriginEvidence): Change {
  if (permissions.includes('draft:read:full')) return change;
  const draft = draftView(change.draft, permissions, evidence);
  const before = change.before ? draftView(change.before, permissions, evidence) : undefined;
  return {
    draft,
    origin: change.origin,
    ...(before ? { before, deltas: [{ origin: 'unknown', from: 0, to: before.text.length, insert: draft.text }] } : {}),
  };
}

class MemoryStorage implements PluginStorage {
  readonly #values = new Map<string, string>();

  async get(key: string): Promise<StorageResult> {
    const value = this.#values.get(key);
    return value === undefined ? { status: 'ok' } : { status: 'ok', value: JSON.parse(value) };
  }

  async set(key: string, value: unknown): Promise<StorageResult> {
    const json = JSON.stringify(value);
    if (json === undefined) return { status: 'error', reason: 'not JSON' };
    this.#values.set(key, json);
    return { status: 'ok' };
  }

  async delete(key: string): Promise<StorageResult> {
    this.#values.delete(key);
    return { status: 'ok' };
  }

  json(): string {
    return JSON.stringify(Object.fromEntries([...this.#values].map(([k, v]) => [k, JSON.parse(v)])));
  }
}

interface Loaded {
  readonly spec: DirectPluginSpec;
  readonly plugin: Plugin;
  readonly permissions: readonly Permission[];
  readonly storage: MemoryStorage;
  readonly settings: Readonly<Record<string, unknown>>;
}

export function createDirectRunner(options: DirectRunnerOptions): DirectRunner {
  const loaded = new Map<string, Loaded>();
  // Kept after a plugin unloads, so a disabled plugin's data can still be inspected.
  const storages = new Map<string, MemoryStorage>();
  let disposed = false;

  const context = (call: HookCall, entry: Loaded): PluginContext => {
    const { snapshot } = call;
    const evidence = snapshot.host.caps.inputOriginEvidence;
    const draft = draftView(snapshot.draft, entry.permissions, evidence);
    return {
      host: clone(snapshot.host) as PluginContext['host'],
      draft: clone(draft),
      state: clone(snapshot.state),
      ...(snapshot.change ? { change: clone(changeView(snapshot.change, entry.permissions, evidence)) } : {}),
      settings: clone(entry.settings),
      signal: call.signal,
      clock: options.clock,
      storage: entry.storage,
      project: {
        read: async () => ({ status: 'denied', reason: 'project reads need the phase 09 broker' }),
      },
    };
  };

  const args = (call: HookCall, entry: Loaded): unknown[] => {
    const ctx = context(call, entry);
    if (call.hook === 'activate') return [ctx];
    if (call.hook === 'deactivate') return [];
    if (call.hook === 'onChange') return [ctx.change, ctx];
    return [clone(call.input), ctx];
  };

  return {
    runtime: { executor: 'in-process', hooks: hookNames, services: ['clock', 'storage'] },

    ids(): readonly string[] {
      return options.plugins.map((spec) => spec.id);
    },

    async load(): Promise<readonly LoadedPlugin[]> {
      uniquePluginIds(options.plugins.map((spec) => spec.id));
      const out: LoadedPlugin[] = [];
      for (const spec of options.plugins) {
        try {
          // An enabled inline rule set turns the async typo path off (docs/plan/07).
          const settings = spec.inline?.some((rule) => rule.enabled)
            ? { ...spec.settings, autocorrect: false }
            : (spec.settings ?? {});
          const plugin = spec.factory(clone(settings));
          const descriptor = descriptorOf(spec.id, plugin);
          const storage = new MemoryStorage();
          storages.set(spec.id, storage);
          loaded.set(spec.id, { spec, plugin, permissions: descriptor.permissions, storage, settings });
          out.push({
            descriptor,
            builtin: spec.builtin,
            ...(spec.inline ? { inline: spec.inline } : {}),
            ...(spec.assets ? { assets: spec.assets } : {}),
          });
        } catch (error) {
          const descriptor: PluginDescriptor = {
            id: spec.id,
            name: spec.id,
            version: 'unknown',
            permissions: [],
            guard: false,
            keys: [],
            actions: [],
            hooks: [],
          };
          out.push({
            descriptor,
            builtin: spec.builtin,
            loadError: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return out;
    },

    async run(call: HookCall): Promise<unknown> {
      // Never inside the caller's stack: the adapter's callback has returned before plugin code runs.
      await Promise.resolve();
      if (disposed || call.signal.cancelled) throw new CancelledError();
      const entry = loaded.get(call.pluginId);
      if (!entry) throw fault('exception', `plugin ${call.pluginId} is not loaded`);
      const hook = entry.plugin[call.hook] as ((...a: unknown[]) => unknown) | undefined;
      if (typeof hook !== 'function') return undefined;
      let result: unknown;
      try {
        result = await hook.apply(entry.plugin, args(call, entry));
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'cancelled') throw error;
        throw fault('exception', error instanceof Error ? error.message : String(error));
      }
      if (call.signal.cancelled) throw new CancelledError();
      return result;
    },

    async unload(pluginId: string): Promise<void> {
      const entry = loaded.get(pluginId);
      loaded.delete(pluginId);
      try {
        await entry?.plugin.deactivate?.();
      } catch {
        // A plugin that fails to deactivate is gone anyway.
      }
    },

    health(): RunnerHealth {
      return options.health ?? (disposed ? 'down' : 'ok');
    },

    async dispose(): Promise<void> {
      disposed = true;
      for (const id of [...loaded.keys()]) await this.unload(id);
    },

    storage(): Readonly<Record<string, string>> {
      return Object.fromEntries([...storages].map(([id, storage]) => [id, storage.json()]));
    },
  };
}

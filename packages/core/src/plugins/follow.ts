// `murmo plugin add`, `update`, `enable`, `disable`, `remove`, `grant` and
// `revoke-grant` change the selection while sessions run. A running session
// follows it plugin by plugin: an installed plugin that was added, updated or
// regranted loads again and replaces its running copy, one that was removed
// or disabled is unloaded, a built-in turns off or on. Every other plugin
// keeps its in-memory state (E5), and key handling never waits for this.

import type { Permission } from '@murmo/api';
import type { PluginActivation, Session } from '../session.ts';
import type { HostPluginSpec, PluginHost } from './host.ts';
import { type InstalledSelection, type PluginTables, withInstalled } from './installed.ts';

export interface PluginFollowerOptions {
  readonly session: Pick<Session, 'applyPlugin' | 'caps' | 'stats'>;
  readonly host: Pick<PluginHost, 'loadOne'>;
  /** The host's built-in specs as they are now, to start one that began the session off. */
  readonly builtins: () => readonly HostPluginSpec[];
  /** `[plugins.<id>]` from murmo.toml as it is now. */
  readonly tables?: () => PluginTables;
}

/** What each plugin of the session is after a change, for the CLI waiting on it. */
export interface FollowResult {
  readonly plugins: Readonly<Record<string, PluginActivation>>;
  /** Why a plugin that should run did not start. */
  readonly errors: Readonly<Record<string, string>>;
}

export interface PluginFollower {
  /** Applies a new selection; changes nothing for a plugin whose code, grants and state are the same. */
  apply(next: InstalledSelection): Promise<FollowResult>;
}

/** Each plugin of a session: off, started, or loaded and starting. */
export function pluginStates(session: Pick<Session, 'stats'>): Record<string, PluginActivation> {
  const states: Record<string, PluginActivation> = {};
  for (const plugin of session.stats().plugins) {
    states[plugin.id] = plugin.disabled ? 'disabled' : plugin.activated ? 'activated' : 'loaded';
  }
  return states;
}

/** The installed plugins a selection runs, keyed by what makes a running copy stale. */
function installedOf(
  selection: InstalledSelection,
  builtins: readonly HostPluginSpec[],
  tables: PluginTables,
): Map<string, { readonly spec: HostPluginSpec; readonly grants: readonly Permission[]; readonly key: string }> {
  const plan = withInstalled({ specs: builtins, order: [], grants: {} }, selection, tables);
  const out = new Map<string, { spec: HostPluginSpec; grants: readonly Permission[]; key: string }>();
  for (const spec of plan.specs) {
    if (spec.builtin) continue;
    const grants = plan.grants[spec.id] ?? [];
    out.set(spec.id, { spec, grants, key: JSON.stringify([spec.source, grants, spec.settings ?? null]) });
  }
  return out;
}

export function followPlugins(started: InstalledSelection, options: PluginFollowerOptions): PluginFollower {
  const tables = () => options.tables?.() ?? {};
  let running = new Map(
    [...installedOf(started, options.builtins(), tables())].map(([id, entry]) => [id, entry.key] as const),
  );
  let off = new Set(started.disabled);

  return {
    async apply(next) {
      const { session, host } = options;
      const changed: Record<string, PluginActivation> = {};
      const errors: Record<string, string> = {};
      const order = next.order ?? [];
      const runs = (id: string) => session.stats().plugins.some((plugin) => plugin.id === id);
      const start = async (spec: HostPluginSpec, grants?: readonly Permission[]) => {
        const loaded = await host.loadOne(spec, session.caps(), grants);
        changed[spec.id] = await session.applyPlugin({ action: 'replace', plugin: loaded, order });
        if (loaded.loadError !== undefined) errors[spec.id] = loaded.loadError;
      };

      const builtins = options.builtins();
      const wanted = installedOf(next, builtins, tables());
      for (const id of running.keys()) {
        if (wanted.has(id)) continue;
        changed[id] = await session.applyPlugin({ action: 'remove', id });
      }
      for (const [id, entry] of wanted) {
        if (running.get(id) === entry.key) continue;
        // Off first, so no hook reaches the old copy while the new one loads.
        if (running.has(id)) await session.applyPlugin({ action: 'disable', id });
        await start(entry.spec, entry.grants);
      }
      running = new Map([...wanted].map(([id, entry]) => [id, entry.key] as const));

      const nextOff = new Set(next.disabled);
      for (const spec of builtins) {
        const id = spec.id;
        if (nextOff.has(id) && !off.has(id) && runs(id)) {
          changed[id] = await session.applyPlugin({ action: 'disable', id });
        } else if (off.has(id) && !nextOff.has(id)) {
          if (runs(id)) changed[id] = await session.applyPlugin({ action: 'enable', id });
          else await start(spec);
        }
      }
      off = nextOff;

      return { plugins: { ...pluginStates(session), ...changed }, errors };
    },
  };
}

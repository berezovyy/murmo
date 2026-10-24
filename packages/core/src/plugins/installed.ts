// Join a host's built-ins with what `murmo plugin` selected: built-ins the
// user disabled drop out, installed third-party plugins join after them in
// install order, each with only the grants the user reviewed. Every adapter
// uses this, so no host can load a plugin with grants it was never given.

import type { Permission, PluginManifest } from '@murmo/api';
import type { HostPluginSpec } from './host.ts';
import type { GrantMap } from './permissions.ts';

/** The shape `readPluginSelection` (`@murmo/store`) returns. */
export interface InstalledSelection {
  readonly plugins: readonly {
    readonly id: string;
    readonly source: string;
    readonly manifest: PluginManifest;
    readonly grants: readonly Permission[];
  }[];
  readonly disabled: readonly string[];
  readonly notices: readonly string[];
}

export interface SessionPlugins {
  readonly specs: HostPluginSpec[];
  readonly order: readonly string[];
  readonly grants: GrantMap;
  readonly notices: readonly string[];
}

/** `[plugins.<id>]` from murmo.toml: `enabled = false` keeps it off, `settings` go to its factory. */
export type PluginTables = Readonly<
  Record<string, { readonly enabled?: boolean; readonly settings?: Readonly<Record<string, unknown>> }>
>;

export function withInstalled(
  builtins: { readonly specs: readonly HostPluginSpec[]; readonly order: readonly string[]; readonly grants: GrantMap },
  selection: InstalledSelection,
  tables: PluginTables = {},
): SessionPlugins {
  const off = new Set(selection.disabled);
  const taken = new Set(builtins.specs.map((spec) => spec.id));
  const notices = [...selection.notices];
  const installed: HostPluginSpec[] = [];
  const grants: Record<string, readonly Permission[]> = { ...builtins.grants };
  for (const plugin of selection.plugins) {
    if (taken.has(plugin.id)) {
      notices.push(`${plugin.id} was not loaded: a built-in plugin has that name`);
      continue;
    }
    taken.add(plugin.id);
    const table = tables[plugin.id];
    if (table?.enabled === false) continue;
    const settings = table?.settings && Object.keys(table.settings).length ? { settings: table.settings } : {};
    installed.push({ id: plugin.id, builtin: false, source: plugin.source, manifest: plugin.manifest, ...settings });
    grants[plugin.id] = plugin.grants;
  }
  const specs = [...builtins.specs.filter((spec) => !off.has(spec.id)), ...installed];
  const order = [...builtins.order.filter((id) => !off.has(id)), ...installed.map((spec) => spec.id)];
  return { specs, order, grants, notices };
}

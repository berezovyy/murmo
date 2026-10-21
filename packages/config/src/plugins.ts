// A plugin sees only its own settings, checked against its manifest schema
// (phase 03, "Settings keys from 14": config, not API). Host-owned keys such as
// the `enabled` switch were split off by the parser and never reach it.
import { ManifestError, type PluginManifest, resolveSettings } from '@murmo/api';
import type { EffectiveConfig } from './merge.ts';

/** Keys of `[plugins.<id>]` the host reads itself; a manifest may not declare them as settings. */
export const HOST_OWNED_PLUGIN_KEYS: readonly string[] = ['enabled'];

export type PluginSettingsResult =
  | { readonly status: 'ok'; readonly settings: Record<string, unknown> }
  | { readonly status: 'invalid'; readonly path: string; readonly message: string };

/**
 * The settings plugin `id`'s factory receives: the merged `[plugins.<id>]`
 * table without host-owned keys, resolved with defaults and required keys.
 * `invalid` means the plugin must not load with these settings; the message
 * names the setting (fail closed for that plugin, open for the others).
 */
export function pluginSettings(config: EffectiveConfig, id: string, manifest: PluginManifest): PluginSettingsResult {
  const table = Object.hasOwn(config.plugins, id) ? config.plugins[id] : undefined;
  try {
    return { status: 'ok', settings: resolveSettings(manifest, table?.settings ?? {}) };
  } catch (error) {
    if (error instanceof ManifestError) return { status: 'invalid', path: error.path, message: error.message };
    throw error;
  }
}

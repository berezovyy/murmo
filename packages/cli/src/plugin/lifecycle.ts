// Open sessions watch plugins.json and reload only the plugin whose selection
// changed. They never recreate the coordinator (E5). Acknowledgements are
// per-plugin activation outcomes, not a healthy-session flag (E9).

import { type FSWatcher, watch } from 'node:fs';
import type { PluginActivation, PluginChange, Session } from '@murmo/core';
import { pluginsManifestPath, type StoreRoots } from '@murmo/store';
import {
  type ActivationOutcome,
  type InstalledPlugin,
  type PluginsManifest,
  readPluginsManifest,
  writeSessionAck,
} from '@murmo/store/node';

export function selectionDiff(previous: PluginsManifest | undefined, next: PluginsManifest): PluginChange[] {
  const changes: PluginChange[] = [];
  const seen = new Set<string>();
  for (const [id, plugin] of Object.entries(next.plugins)) {
    seen.add(id);
    const old = previous?.plugins[id];
    if (!old) {
      if (plugin.enabled === false) changes.push({ action: 'disable', id });
      continue;
    }
    if (old.enabled !== plugin.enabled) {
      changes.push({ action: plugin.enabled ? 'enable' : 'disable', id });
      continue;
    }
    if (digestOf(old) !== digestOf(plugin)) {
      // Caller loads the new generation, then applyPlugin({ action: 'replace', plugin }).
      changes.push({ action: 'disable', id });
      if (plugin.enabled) changes.push({ action: 'enable', id });
    }
  }
  if (previous) {
    for (const id of Object.keys(previous.plugins)) {
      if (!seen.has(id)) changes.push({ action: 'remove', id });
    }
  }
  return changes;
}

function digestOf(plugin: InstalledPlugin): string | undefined {
  return plugin.distribution?.digest;
}

export interface FollowSelectionOptions {
  readonly roots: StoreRoots;
  readonly sessionId: string;
  readonly host: string;
  readonly pid?: number;
  readonly session: Session;
  /** Load a distributed generation so the session can replace that one plugin. */
  readonly loadDistributed?: (id: string, plugin: InstalledPlugin) => Promise<PluginChange | undefined>;
}

export interface FollowSelection {
  readonly stop: () => Promise<void>;
  readonly apply: (manifest: PluginsManifest) => Promise<void>;
  current(): PluginsManifest | undefined;
}

export async function followSelection(options: FollowSelectionOptions): Promise<FollowSelection> {
  let current = await readPluginsManifest(options.roots);
  const pid = options.pid ?? process.pid;
  const ack = async (
    manifest: PluginsManifest,
    plugins: Record<string, ActivationOutcome>,
    errors?: Record<string, string>,
  ) => {
    await writeSessionAck(options.roots, options.sessionId, {
      schema: 1,
      pid,
      host: options.host,
      revision: manifest.revision,
      plugins,
      ...(errors && Object.keys(errors).length ? { errors } : {}),
    });
  };

  const apply = async (manifest: PluginsManifest): Promise<void> => {
    const diff = selectionDiff(current, manifest);
    const outcomes: Record<string, ActivationOutcome> = {};
    const errors: Record<string, string> = {};
    for (const [id, plugin] of Object.entries(manifest.plugins)) {
      outcomes[id] = plugin.enabled === false ? 'disabled' : 'loaded';
    }
    for (const change of diff) {
      try {
        let next = change;
        if (change.action === 'enable' && options.loadDistributed) {
          const installed = manifest.plugins[change.id];
          if (installed?.distribution) {
            const loaded = await options.loadDistributed(change.id, installed);
            if (loaded) next = loaded;
          }
        }
        const outcome: PluginActivation = await options.session.applyPlugin(next);
        const id = change.action === 'replace' ? change.plugin.descriptor.id : change.id;
        outcomes[id] = outcome;
        if (outcome === 'error') errors[id] = 'activation error';
      } catch (error) {
        const id = change.action === 'replace' ? change.plugin.descriptor.id : change.id;
        outcomes[id] = 'error';
        errors[id] = error instanceof Error ? error.message : String(error);
      }
    }
    current = manifest;
    await ack(manifest, outcomes, errors);
  };

  if (current) {
    const initial: Record<string, ActivationOutcome> = {};
    for (const [id, plugin] of Object.entries(current.plugins)) {
      initial[id] = plugin.enabled === false ? 'disabled' : 'activated';
    }
    await ack(current, initial);
  }

  let watcher: FSWatcher | undefined;
  const path = pluginsManifestPath(options.roots);
  try {
    watcher = watch(path, { persistent: false }, () => {
      void readPluginsManifest(options.roots).then((manifest) => {
        if (manifest && manifest.revision !== current?.revision) return apply(manifest);
      });
    });
  } catch {
    // Tests can call apply() directly when watch is unavailable.
  }

  return {
    apply,
    current: () => current,
    async stop() {
      watcher?.close();
    },
  };
}

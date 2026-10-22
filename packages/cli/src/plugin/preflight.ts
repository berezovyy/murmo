// Bounded preflight: load the candidate in-process, check the descriptor
// against the signed envelope, activate, and return storage. First-party
// plugins run in-process; the isolated guest is the seam for phase 32.

import { pathToFileURL } from 'node:url';
import type { Permission, Plugin, PluginContext, PluginFactory } from '@murmo/api';
import { createMemoryStorage, createStorageBroker } from '@murmo/core';
import { createClock } from '@murmo/executor';
import type { InspectedPlugin } from '@murmo/integrity';
import { fail } from './errors.ts';

export interface PreflightResult {
  readonly storage: Record<string, unknown>;
}

const emptyDraft = { text: '', cursor: 0, version: 0, certainty: 'unknown' as const, typedSpans: [] as const };

async function loadFactory(entryPath: string): Promise<PluginFactory> {
  const href = `${pathToFileURL(entryPath).href}?preflight=${Date.now()}`;
  const mod = (await import(href)) as { default?: unknown };
  if (typeof mod.default !== 'function') fail('load-failed', { error: 'plugin entry must default-export a factory' });
  return mod.default as PluginFactory;
}

function asPlugin(value: unknown): Plugin {
  if (!value || typeof value !== 'object') fail('load-failed', { error: 'factory did not return a plugin' });
  return value as Plugin;
}

export async function preflightActivate(
  inspected: InspectedPlugin,
  entryPath: string,
  data: Record<string, unknown>,
  _grants: readonly Permission[],
): Promise<PreflightResult> {
  const factory = await loadFactory(entryPath);
  let plugin: Plugin;
  try {
    plugin = asPlugin(factory({}));
  } catch (error) {
    fail('load-failed', { error: error instanceof Error ? error.message : String(error) });
  }
  const declared = plugin.permissions ?? [];
  if (declared.some((name) => !inspected.envelope.permissions.includes(name))) {
    fail('descriptor-permissions-mismatch', { declared, envelope: inspected.envelope.permissions });
  }
  if (plugin.name !== inspected.envelope.id || plugin.version !== inspected.envelope.version) {
    fail('descriptor-version-mismatch', { name: plugin.name, version: plugin.version });
  }
  const backend = createMemoryStorage();
  await backend.save(inspected.envelope.id, JSON.stringify(data));
  const storage = createStorageBroker(backend).forPlugin(inspected.envelope.id);
  const clock = createClock();
  const ctx: PluginContext = {
    host: { name: 'fake', version: 'preflight', caps: { status: true } as PluginContext['host']['caps'] },
    draft: emptyDraft,
    state: { mode: 'prose', popup: null, dialog: false, busy: false, editorMode: 'insert', history: false },
    settings: {},
    signal: { cancelled: false },
    clock,
    storage,
    project: {
      read: async () => ({ status: 'denied', reason: 'fs:project-read must be declared, granted and brokered' }),
      list: async () => ({ status: 'denied', reason: 'project:list must be declared, granted and brokered' }),
    },
    network: { request: async () => ({ status: 'denied', reason: 'network must be declared, granted and brokered' }) },
    git: { query: async () => ({ status: 'denied', reason: 'project:git must be declared, granted and brokered' }) },
    session: { id: 'preflight' },
  };
  if (typeof plugin.activate === 'function') {
    try {
      await plugin.activate(ctx);
    } catch (error) {
      fail('activation-failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  const raw = await backend.load(inspected.envelope.id);
  let storageOut: Record<string, unknown> = data;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) storageOut = parsed as Record<string, unknown>;
  } catch {
    storageOut = data;
  }
  return { storage: storageOut };
}

export function migrateStorage(
  data: Record<string, unknown>,
  fromVersion: number,
  envelope: InspectedPlugin['envelope'],
): Record<string, unknown> {
  if (fromVersion === envelope.storageVersion) return { ...data };
  if (envelope.migration?.from !== fromVersion) {
    fail('migration-required', { from: fromVersion, to: envelope.storageVersion });
  }
  const next: Record<string, unknown> = { ...data };
  for (const [from, to] of Object.entries(envelope.migration.rename)) {
    if (!Object.hasOwn(next, from)) continue;
    if (Object.hasOwn(next, to)) fail('migration-key-exists', { from, to });
    next[to] = next[from];
    delete next[from];
  }
  return next;
}

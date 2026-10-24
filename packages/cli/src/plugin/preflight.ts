// Bounded preflight: load the candidate in the isolated helper, inside the
// same OS sandbox the hosts give a third-party plugin, check its descriptor
// against the signed envelope, activate it once and return its storage. Its
// code never runs in the CLI's own process.

import type { PluginContext } from '@murmo/api';
import { DEADLINES } from '@murmo/api';
import type { Executor, PluginDescriptor } from '@murmo/api/adapter';
import { createMemoryStorage, createStorageBroker } from '@murmo/core';
import { createNodeIsolatedExecutor } from '@murmo/executor/node';
import type { InspectedPlugin } from '@murmo/integrity';
import { fail } from './errors.ts';

export interface PreflightResult {
  readonly storage: Record<string, unknown>;
}

/** Where preflight runs plugin code: the isolated helper unless a test supplies a stand-in. */
export type PreflightExecutor = () => Executor;

const emptyDraft = { text: '', cursor: 0, version: 0, certainty: 'unknown' as const, typedSpans: [] as const };

/** An error as text. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Escape text for a RegExp. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The helper names the module after the plugin ID (`at hello:13:12`); say
 * the file the author edits instead, on one line.
 */
function located(message: string, id: string, file: string): string {
  return message
    .replace(new RegExp(`\\b${literal(id)}:(\\d+)`, 'g'), `${file}:$1`)
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

async function load(executor: Executor, inspected: InspectedPlugin): Promise<PluginDescriptor> {
  const file = inspected.envelope.entry;
  const bytes = inspected.files[file];
  if (!bytes) fail('load-failed', { file, error: 'the package has no such file' });
  try {
    return await executor.load({
      id: inspected.envelope.id,
      builtin: false,
      source: new TextDecoder().decode(bytes),
      manifest: inspected.portable,
      settings: {},
      sandbox: true,
    });
  } catch (error) {
    fail('load-failed', { file, error: located(messageOf(error), inspected.envelope.id, file) });
  }
}

export async function preflightActivate(
  inspected: InspectedPlugin,
  data: Record<string, unknown>,
  executorOf: PreflightExecutor = () => createNodeIsolatedExecutor(),
): Promise<PreflightResult> {
  const id = inspected.envelope.id;
  const executor = executorOf();
  try {
    const plugin = await load(executor, inspected);
    if (plugin.permissions.some((name) => !inspected.envelope.permissions.includes(name))) {
      fail('descriptor-permissions-mismatch', {
        declared: plugin.permissions,
        envelope: inspected.envelope.permissions,
      });
    }
    if (plugin.name !== id || plugin.version !== inspected.envelope.version) {
      fail('descriptor-version-mismatch', {
        entry: inspected.envelope.entry,
        name: plugin.name,
        version: plugin.version,
        expectedName: id,
        expectedVersion: inspected.envelope.version,
      });
    }
    const backend = createMemoryStorage();
    await backend.save(id, JSON.stringify(data));
    if (plugin.hooks.includes('activate')) {
      try {
        await executor.run(id, 'activate', null, context(executor, createStorageBroker(backend).forPlugin(id)), {
          timeoutMs: DEADLINES.activateMs,
        });
      } catch (error) {
        fail('activation-failed', { error: messageOf(error) });
      }
    }
    return { storage: parsedStorage(await backend.load(id), data) };
  } finally {
    await executor.dispose().catch(() => {});
  }
}

/** What `activate` sees: no draft, no project, every broker but storage denied. */
function context(executor: Executor, storage: PluginContext['storage']): PluginContext {
  return {
    host: { name: 'fake', version: 'preflight', caps: { status: true } as PluginContext['host']['caps'] },
    draft: emptyDraft,
    state: { mode: 'prose', popup: null, dialog: false, busy: false, editorMode: 'insert', history: false },
    settings: {},
    signal: { cancelled: false },
    clock: executor.clock,
    storage,
    project: {
      read: async () => ({ status: 'denied', reason: 'fs:project-read must be declared, granted and brokered' }),
      list: async () => ({ status: 'denied', reason: 'project:list must be declared, granted and brokered' }),
    },
    network: { request: async () => ({ status: 'denied', reason: 'network must be declared, granted and brokered' }) },
    git: { query: async () => ({ status: 'denied', reason: 'project:git must be declared, granted and brokered' }) },
    session: { id: 'preflight' },
  };
}

function parsedStorage(raw: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}
  return fallback;
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

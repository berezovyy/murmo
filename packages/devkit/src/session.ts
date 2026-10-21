import type { Permission } from '@murmo/api';
import type { Executor, PluginFactory, ProjectFiles, StorageBackend } from '@murmo/api/adapter';
import {
  createMemoryProjectFiles,
  createMemoryStorage,
  createPluginHost,
  createSession,
  type PluginHost,
  type Session,
} from '@murmo/core';
import { createFakeDriver, type FakeAdapter, type FakeDriver } from '@murmo/fake-host';
import { loadFactory } from './executors.ts';
import type { PreparedPlugin } from './loader.ts';

export interface FakeSession {
  readonly adapter: FakeAdapter;
  readonly executor: Executor;
  readonly runner: PluginHost;
  readonly session: Session;
  readonly driver: FakeDriver;
  dispose(): Promise<void>;
}

export interface StartPluginOptions {
  readonly adapter: FakeAdapter;
  readonly executor: Executor;
  readonly storage?: StorageBackend;
  readonly projectFiles?: ProjectFiles;
  readonly grants?: Readonly<Record<string, readonly Permission[]>>;
  readonly builtin?: boolean;
  readonly factory?: PluginFactory;
  /** `dev` keeps one adapter across generations; do not dispose it on a failed start. */
  readonly keepAdapter?: boolean;
}

export async function startPlugin(prepared: PreparedPlugin, options: StartPluginOptions): Promise<FakeSession> {
  const storage = options.storage ?? createMemoryStorage();
  const projectFiles =
    options.projectFiles ??
    createMemoryProjectFiles({
      files: { 'ok.txt': 'ok' },
      approved: [prepared.manifest.name],
    });
  const factory =
    options.factory ?? (options.executor.kind === 'in-process' ? await loadFactory(prepared.source) : undefined);
  const runner = createPluginHost({
    specs: [
      {
        id: prepared.manifest.name,
        builtin: options.builtin === true,
        source: prepared.source,
        manifest: prepared.manifest,
        settings: prepared.settings,
        ...(factory ? { factory } : {}),
      },
    ],
    executor: options.executor,
    storage,
    projectFiles,
    ...(options.grants ? { grants: options.grants } : {}),
  });
  const session = createSession({ adapter: options.adapter, runner, keyBursts: true });
  try {
    await session.ready;
    await session.settle();
    const stats = session.stats();
    if (stats.disabled.length) {
      throw new Error(stats.notices.join('; ') || `plugin disabled: ${stats.disabled.join(', ')}`);
    }
    const driver = createFakeDriver(options.adapter, session);
    return {
      adapter: options.adapter,
      executor: options.executor,
      runner,
      session,
      driver,
      async dispose() {
        await session.dispose();
        if (!options.keepAdapter) options.adapter.dispose();
      },
    };
  } catch (error) {
    await session.dispose().catch(() => {});
    if (!options.keepAdapter) options.adapter.dispose();
    throw error;
  }
}

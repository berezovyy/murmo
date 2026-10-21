// Wire the Pi adapter to a core session: in-process executor for built-ins,
// optional isolated helper for third-party specs, config + store off the key
// path. Async isolated hooks run after the native input frame (setImmediate).

import type { Executor } from '@murmo/api/adapter';
import { loadSessionConfig } from '@murmo/config/node';
import { createPluginHost, createSession, type HostPluginSpec, type PluginHost, type Session } from '@murmo/core';
import { createFileStorage, createProjectFileBroker } from '@murmo/core/node';
import { createInProcessExecutor } from '@murmo/executor';
import { createNodeIsolatedExecutor } from '@murmo/executor/node';
import { findRepositoryRoot, openStore, projectIdentity, storeRootsFromEnv } from '@murmo/store/node';
import { createPiAdapter, type PiAdapter, type PiAdapterOptions } from './adapter.ts';
import { loadBuiltins } from './plugins.ts';
import type { PiHost, PiSessionContext } from './types.ts';

export interface StartedPi {
  readonly adapter: PiAdapter;
  readonly session: Session;
  readonly runner: PluginHost;
  readonly executor: Executor;
  dispose(): Promise<void>;
}

export interface StartOptions extends PiAdapterOptions {
  readonly cwd?: string;
  readonly specs?: readonly HostPluginSpec[];
  readonly order?: readonly string[];
  readonly isolated?: boolean;
  readonly notify?: (message: string) => void;
}

function frameExecutor(inner: Executor): Executor {
  const pending = new Map<ReturnType<typeof setImmediate>, (reason: unknown) => void>();
  let disposed = false;
  return {
    kind: inner.kind,
    clock: inner.clock,
    load: (spec) => inner.load(spec),
    run(id, hook, input, ctx, opts) {
      const start = inner.clock.now();
      return new Promise((resolve, reject) => {
        const handle = setImmediate(() => {
          pending.delete(handle);
          if (disposed || opts.signal?.cancelled) {
            reject(Object.assign(new Error('executor cancelled'), { code: 'cancelled' }));
            return;
          }
          const delay = inner.clock.now() - start;
          const remaining = opts.timeoutMs - delay;
          if (remaining <= 0) {
            reject(Object.assign(new Error('executor scheduling deadline'), { code: 'timeout' }));
            return;
          }
          inner.run(id, hook, input, ctx, { ...opts, timeoutMs: remaining }).then(resolve, reject);
        });
        pending.set(handle, reject);
      });
    },
    unload: (id) => inner.unload(id),
    async dispose() {
      disposed = true;
      for (const [handle, reject] of pending) {
        clearImmediate(handle);
        reject(Object.assign(new Error('executor cancelled'), { code: 'cancelled' }));
      }
      pending.clear();
      await inner.dispose();
    },
    stats: () => inner.stats(),
  };
}

export async function startPiSession(options: StartOptions): Promise<StartedPi> {
  const { adapter } = createPiAdapter(options);
  const cwd = options.cwd ?? (typeof process !== 'undefined' ? process.cwd() : '.');
  const store = await openStore({ roots: storeRootsFromEnv() });
  const config = await loadSessionConfig({ cwd, store });
  const repo = await findRepositoryRoot(cwd);
  const project = repo ? await projectIdentity(repo) : undefined;
  const identity = {
    project: project?.projectId ?? '0'.repeat(64),
    host: 'pi' as const,
    session: `pi-${Date.now().toString(16)}`,
  };
  const loaded = options.specs
    ? {
        specs: [...options.specs],
        order: options.order ?? options.specs.map((spec) => spec.id),
        notices: [] as string[],
      }
    : loadBuiltins({
        config: config.effective,
        drafts: store.drafts,
        identity,
        cwd,
      });
  for (const notice of loaded.notices) options.ctx.ui.notify(notice, 'warning');

  const trusted = createInProcessExecutor();
  const executor: Executor = options.isolated ? frameExecutor(createNodeIsolatedExecutor()) : trusted;
  const storage = await createFileStorage(`${store.layout.store}/adapter-namespaces`);
  const projectFiles = await createProjectFileBroker({
    root: cwd,
    requestTrust: async () => config.trust === 'approved' || config.trust === 'none',
  });
  if (loaded.specs.some((spec) => spec.id === 'autocorrect')) await projectFiles.authorize('autocorrect');

  const runner = createPluginHost({
    specs: loaded.specs,
    executor,
    storage,
    projectFiles,
    grants: {
      autocorrect: ['draft:read', 'draft:write'],
      shortcuts: ['draft:read', 'draft:write'],
      menu: ['draft:read', 'draft:write'],
      rescue: ['draft:read', 'draft:write', 'submit:observe'],
    },
  });
  const session = createSession({
    adapter,
    runner,
    keyBursts: true,
    order: loaded.order,
    notify: options.notify ?? ((message) => options.ctx.ui.notify(message, 'warning')),
  });
  await session.ready;
  await session.settle();
  return {
    adapter,
    session,
    runner,
    executor,
    async dispose() {
      await session.dispose();
      await adapter.dispose();
      await executor.dispose();
      await projectFiles.dispose();
    },
  };
}

export async function startPiOnContext(
  pi: PiHost,
  ctx: PiSessionContext,
  adapterOptions: Omit<StartOptions, 'ctx' | 'pi'>,
): Promise<StartedPi> {
  return startPiSession({ ...adapterOptions, ctx, pi });
}

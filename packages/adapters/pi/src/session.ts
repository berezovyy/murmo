// Wire the Pi adapter to a core session: built-ins in-process, the plugins
// `murmo plugin add` installed in the isolated helper with their reviewed
// grants, config + store off the key path. Async isolated hooks run after
// the native input frame (setImmediate).

import type { Clock } from '@murmo/api';
import type { Executor } from '@murmo/api/adapter';
import { loadedSession, loadSessionConfig } from '@murmo/config/node';
import {
  createPluginHost,
  createSession,
  type HostPluginSpec,
  type PluginHost,
  type Session,
  withInstalled,
} from '@murmo/core';
import { createFileStorage, createProjectFileBroker } from '@murmo/core/node';
import { createInProcessExecutor, createRoutedExecutor } from '@murmo/executor';
import { createNodeIsolatedExecutor } from '@murmo/executor/node';
import { findOffer } from '@murmo/plugin-rescue';
import { EMPTY_SELECTION, newDraftSession } from '@murmo/store';
import {
  findRepositoryRoot,
  openStore,
  projectIdentity,
  projectIdOfCwd,
  readInstalledPlugins,
  storeRootsFromEnv,
} from '@murmo/store/node';
import { createPiAdapter, type PiAdapter, type PiAdapterOptions } from './adapter.ts';
import { attachPiEvents, type PiEventsHandle } from './events.ts';
import { loadBuiltins } from './plugins.ts';
import type { PiHost, PiSessionContext } from './types.ts';

export interface StartedPi {
  readonly adapter: PiAdapter;
  readonly session: Session;
  readonly runner: PluginHost;
  readonly executor: Executor;
  readonly events?: PiEventsHandle;
  dispose(): Promise<void>;
}

export interface StartOptions extends PiAdapterOptions {
  readonly cwd?: string;
  /** Tests: these specs instead of the built-ins and the installed plugins. */
  readonly specs?: readonly HostPluginSpec[];
  readonly order?: readonly string[];
  /** Run every plugin, built-ins included, in the helper (tests of the helper route). */
  readonly isolated?: boolean;
  /** Where installed third-party plugins run; default the isolated helper. Tests pass a stand-in. */
  readonly thirdParty?: (clock: Clock) => Executor;
  readonly notify?: (message: string) => void;
  readonly pi?: PiHost;
}

const BUILTIN_GRANTS = {
  autocorrect: ['draft:read', 'draft:write'],
  shortcuts: ['draft:read', 'draft:write'],
  menu: ['draft:read', 'draft:write'],
  rescue: ['draft:read', 'draft:write', 'submit:observe'],
  names: ['draft:read', 'draft:write'],
} as const;

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
  const roots = storeRootsFromEnv();
  const store = await openStore({ roots });
  const config = await loadSessionConfig({ cwd, store });
  const repo = await findRepositoryRoot(cwd);
  const project = repo ? await projectIdentity(repo) : undefined;
  const sessionId = newDraftSession('pi');
  const identity = { project: project?.projectId ?? '0'.repeat(64), host: 'pi' as const, session: sessionId };
  // Looked up before the session starts, so the offer is on the empty prompt
  // at once: a hook can't wait on the file system.
  const rescue = {
    project: await projectIdOfCwd(cwd).catch(() => identity.project),
    host: 'pi' as const,
    session: sessionId,
  };
  const offer = options.specs ? undefined : await findOffer(store.drafts, rescue);
  const builtins = options.specs
    ? {
        specs: [...options.specs],
        order: options.order ?? options.specs.map((spec) => spec.id),
        notices: [] as string[],
      }
    : loadBuiltins({
        config: config.effective,
        session: loadedSession(config),
        drafts: store.drafts,
        identity,
        rescue: { identity: rescue, ...(offer ? { offer } : {}) },
        store,
        cwd,
      });

  const loaded = withInstalled(
    { specs: builtins.specs, order: builtins.order, grants: BUILTIN_GRANTS },
    options.specs ? EMPTY_SELECTION : await readInstalledPlugins(roots),
    config.effective.plugins,
  );
  const notices = [...builtins.notices, ...loaded.notices];

  const trusted = createInProcessExecutor();
  const executor: Executor = options.isolated
    ? frameExecutor(createNodeIsolatedExecutor())
    : createRoutedExecutor({
        trusted,
        isolated: () =>
          frameExecutor(options.thirdParty?.(trusted.clock) ?? createNodeIsolatedExecutor({ clock: trusted.clock })),
      });
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
    grants: loaded.grants,
  });
  const session = createSession({
    adapter,
    runner,
    keyBursts: true,
    order: loaded.order,
    notices,
    notify: options.notify ?? ((message) => options.ctx.ui.notify(message, 'warning')),
  });
  await session.ready;
  await session.settle();
  let events: PiEventsHandle | undefined;
  if (options.pi && config.effective.events) {
    const enabled = new Set(
      ['audit', 'tool-guard', 'turn-context', 'next-ghost'].filter(
        (id) => config.effective.plugins[id]?.enabled === true,
      ),
    );
    const caps = session.caps();
    if (caps) {
      events = attachPiEvents(options.pi, {
        clock: executor.clock,
        hostVersion: options.version ?? '1.3.0',
        failOpen: config.effective.eventsFailOpen,
        enabled,
        audit: (line) => {
          adapter.notices.push(line.trim());
        },
        draft: () => session.draft() ?? adapter.getDraft(),
        state: () => adapter.getState(),
        sessionId: () => identity.session,
        hostCaps: caps,
        ghost: {
          apply: (_id, text, version) => adapter.showGhost(text, version),
        },
      });
    }
  }
  return {
    adapter,
    session,
    runner,
    executor,
    ...(events ? { events } : {}),
    async dispose() {
      events?.dispose();
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

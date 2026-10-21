// Isolated Executor over a helper transport (stdio or HTTP). Portable: the
// Node spawn and Claude `$.http.fetch` sockets live beside this file.

import type { Clock, PluginContext, PluginHook } from '@murmo/api';
import { LIMITS } from '@murmo/api';
import type { ExecutionOptions, Executor, PluginDescriptor, PluginSpec } from '@murmo/api/adapter';
import { type BudgetPolicyOptions, createBudgetPolicy } from './budget.ts';
import { createClock } from './clock.ts';
import { executorFault } from './fault.ts';

const PROTOCOL = 1;
const API_VERSION = '2.0.0';
const FIRST_PARTY_SLOT = 'first-party';

export interface HelperTransport {
  request(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
  readonly pid?: number;
  /** Subscribe to supervisor death; returns unsubscribe. */
  onExit(callback: (code: number | null) => void): () => void;
}

export interface IsolatedStats {
  readonly kind: 'isolated';
  readonly hardLimits: true;
  readonly calls: number;
  readonly plugins: number;
  readonly loads: number;
  readonly pressureScale: number;
  readonly pid?: number;
  readonly restarts: number;
  readonly down: boolean;
  readonly services: {
    readonly storage: 'brokered';
    readonly projectRead: 'brokered';
    readonly submitCommitted: true;
    readonly projectFileChange: true;
  };
  readonly admissions: Readonly<Record<string, number>>;
  readonly cpuAccounting: 'thread-cputime';
  readonly responseBytes: number;
  readonly maxEffects: number;
  readonly transport: 'real-rquickjs-process';
}

export interface IsolatedExecutor extends Executor {
  readonly kind: 'isolated';
  stats(): IsolatedStats;
}

export interface IsolatedExecutorOptions extends BudgetPolicyOptions {
  readonly clock?: Clock;
  readonly maxMemoryMiB?: number;
  /** Plugin IDs that share one worker. Strangers never join it. */
  readonly firstParty?: readonly string[];
  /** Restart the supervisor at most this many times per 60 s, then stay down. */
  readonly restartLimit?: number;
  readonly connect: () => HelperTransport | Promise<HelperTransport>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function encodeBase64(bytes: Uint8Array): string {
  const btoa = (globalThis as { btoa?: (s: string) => string }).btoa;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  if (typeof btoa === 'function') return btoa(binary);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : chars[(((b1 ?? 0) & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : chars[b2 & 63];
  }
  return out;
}

function assetsOf(spec: PluginSpec): Record<string, { encoding: 'base64'; data: string }> | undefined {
  if (!spec.assets) return undefined;
  const out: Record<string, { encoding: 'base64'; data: string }> = {};
  for (const [name, buffer] of Object.entries(spec.assets)) {
    out[name] = { encoding: 'base64', data: encodeBase64(new Uint8Array(buffer)) };
  }
  return out;
}

function wireContext(context: PluginContext): Record<string, unknown> {
  return {
    ...(context.negotiation ? { negotiation: clone(context.negotiation) } : {}),
    host: clone(context.host),
    draft: clone(context.draft),
    state: clone(context.state),
    ...(context.change ? { change: clone(context.change) } : {}),
    settings: clone(context.settings),
  };
}

function throwRow(row: Record<string, unknown>, id: string, hook: PluginHook | 'load'): never {
  const kind = typeof row.kind === 'string' ? row.kind : 'transport';
  const extra = {
    pluginId: id,
    hook,
    ...(typeof row.generation === 'number' ? { generation: row.generation } : {}),
    ...(typeof row.id === 'number' ? { invocationId: row.id } : {}),
  };
  throw Object.assign(executorFault(kind as 'cpu', String(row.error ?? kind), extra), {
    stateReset: row.stateReset === true || row.restarted === true,
  });
}

export function createIsolatedExecutor(options: IsolatedExecutorOptions): IsolatedExecutor {
  const budgets = createBudgetPolicy(options);
  const clock = options.clock ?? createClock();
  const firstParty = new Set(options.firstParty ?? []);
  const maxMemory = options.maxMemoryMiB ?? LIMITS.defaultMemoryMiB;
  const restartLimit = options.restartLimit ?? 3;
  const admissions: Record<string, number> = {};
  const specs = new Map<string, PluginSpec>();
  const group = new Map<string, string>();
  const queues = new Map<string, Promise<unknown>>();
  const ids = new Set<string>();
  let transport: HelperTransport | undefined;
  let ready: Promise<void> | undefined;
  let disposed = false;
  let down = false;
  let calls = 0;
  let loads = 0;
  let restarts = 0;
  let tokens = 0;
  const restartAt: number[] = [];
  let unsubscribeExit: (() => void) | undefined;

  const connect = async (): Promise<HelperTransport> => {
    const next = await options.connect();
    unsubscribeExit?.();
    unsubscribeExit = next.onExit(() => {
      down = true;
    });
    const hello = await next.request({ op: 'hello', protocol: PROTOCOL, apiVersion: API_VERSION });
    if (hello.status !== 'ok' || hello.protocol !== PROTOCOL || hello.apiVersion !== API_VERSION) {
      throw executorFault('transport', `helper protocol mismatch: ${JSON.stringify(hello)}`);
    }
    down = false;
    return next;
  };

  const ensure = async (): Promise<HelperTransport> => {
    if (disposed) throw executorFault('transport', 'disposed');
    if (down) throw executorFault('session-exit', 'helper is down');
    if (!ready) {
      ready = (async () => {
        transport = await connect();
      })();
    }
    try {
      await ready;
    } catch (error) {
      ready = undefined;
      transport = undefined;
      throw error;
    }
    if (!transport) throw executorFault('session-exit', 'helper exited');
    return transport;
  };

  const recover = async (): Promise<HelperTransport> => {
    const now = clock.wallTimeMs();
    while (restartAt.length > 0) {
      const first = restartAt[0];
      if (first === undefined || now - first <= 60_000) break;
      restartAt.shift();
    }
    if (restartAt.length >= restartLimit) {
      down = true;
      throw executorFault('session-exit', 'helper restart budget exhausted');
    }
    restartAt.push(now);
    restarts++;
    unsubscribeExit?.();
    await transport?.close().catch(() => {});
    transport = undefined;
    ready = undefined;
    down = false;
    const next = await ensure();
    for (const spec of specs.values()) {
      await loadOn(next, spec);
    }
    return next;
  };

  const rpc = async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      const t = await ensure();
      return await t.request(message);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'session-exit' || code === 'transport') {
        try {
          return await (await recover()).request(message);
        } catch {
          throw executorFault('session-exit', error instanceof Error ? error.message : String(error));
        }
      }
      throw error;
    }
  };

  const loadOn = async (t: HelperTransport, spec: PluginSpec): Promise<PluginDescriptor> => {
    if (!spec.source) throw executorFault('exception', 'isolated Executor needs source');
    if (spec.source.length > LIMITS.sourceBytes) {
      throw executorFault('output-limit', 'source exceeds 1 MiB');
    }
    const memory = spec.resources?.memoryMiB ?? LIMITS.defaultMemoryMiB;
    if (memory > maxMemory) {
      throw Object.assign(new Error(`memory admission refused: ${memory} MiB`), { code: 'memory' });
    }
    let assetsTotal = 0;
    if (spec.assets) for (const b of Object.values(spec.assets)) assetsTotal += b.byteLength;
    if (assetsTotal > LIMITS.assetBytes) throw executorFault('exception', 'assets exceed 4 MiB');
    const assets = assetsOf(spec);
    const member = {
      id: spec.id,
      source: spec.source,
      settings: spec.settings ?? {},
      ...(assets ? { assets } : {}),
    };
    const grouped = firstParty.has(spec.id);
    let row: Record<string, unknown>;
    if (grouped && ids.has(FIRST_PARTY_SLOT)) {
      row = await t.request({ op: 'join', plugin: FIRST_PARTY_SLOT, member });
    } else if (grouped) {
      row = await t.request({
        op: 'load',
        plugin: FIRST_PARTY_SLOT,
        memoryMiB: memory,
        sliceMs: 5,
        format: 'esm',
        members: [member],
      });
      ids.add(FIRST_PARTY_SLOT);
    } else {
      row = await t.request({
        op: 'load',
        plugin: spec.id,
        source: spec.source,
        format: 'esm',
        settings: spec.settings ?? {},
        memoryMiB: memory,
        sliceMs: 5,
        ...(assets ? { assets } : {}),
      });
    }
    if (row.status !== 'ok') throwRow(row, spec.id, 'load');
    const metadata = (
      grouped ? ((row.members as Record<string, unknown> | undefined)?.[spec.id] ?? row.metadata) : row.metadata
    ) as PluginDescriptor | undefined;
    if (!metadata || typeof metadata !== 'object') throw executorFault('exception', 'helper returned no descriptor');
    group.set(spec.id, grouped ? FIRST_PARTY_SLOT : spec.id);
    ids.add(spec.id);
    admissions[spec.id] = memory;
    loads++;
    return { ...metadata, id: spec.id };
  };

  const slotOf = (id: string): string => group.get(id) ?? id;

  return {
    kind: 'isolated',
    clock,
    async load(spec: PluginSpec): Promise<PluginDescriptor> {
      if (ids.has(spec.id)) throw new Error(`plugin identity ${JSON.stringify(spec.id)} is already loaded`);
      specs.set(spec.id, spec);
      const run = (queues.get('load') ?? Promise.resolve()).then(async () => {
        const t = await ensure();
        return loadOn(t, spec);
      });
      queues.set(
        'load',
        run.then(
          () => {},
          () => {},
        ),
      );
      return run;
    },
    run(id, hook, input, context, runOptions: ExecutionOptions): Promise<unknown> {
      const work = async (): Promise<unknown> => {
        await budgets.sample();
        if (disposed) throw executorFault('cancelled', 'cancelled');
        calls++;
        const scale = budgets.scale();
        const timeoutMs = runOptions.timeoutMs * scale;
        const deadline = clock.now() + timeoutMs;
        const callToken = ++tokens;
        let resume = false;
        let replies: unknown[] = [];
        const plugin = slotOf(id);
        const member = group.get(id) === FIRST_PARTY_SLOT ? id : undefined;
        for (;;) {
          if (clock.now() > deadline) throw executorFault('timeout', 'hook deadline exceeded');
          const row = await rpc({
            op: 'call',
            plugin,
            ...(member ? { member } : {}),
            hook,
            input,
            context: wireContext(context),
            wallTimeMs: clock.wallTimeMs(),
            resume,
            replies,
            sliceMs: Math.ceil(5 * scale),
            deadlineMs: Math.max(1, Math.ceil(deadline - clock.now())),
            callToken,
          });
          if (row.status === 'ok') {
            if (runOptions.signal?.cancelled) throw executorFault('cancelled', 'cancelled');
            return row.value ?? undefined;
          }
          if (row.status !== 'broker') throwRow(row, id, hook);
          replies = [];
          for (const call of (row.requests as { id: number; method: string; args: unknown[] }[] | undefined) ?? []) {
            const [scope, name] = String(call.method).split('.');
            const target = scope === 'storage' ? context.storage : scope === 'project' ? context.project : undefined;
            const table = target as Record<string, (...args: unknown[]) => unknown> | undefined;
            const fn = name === 'readFile' ? (table?.readFile ?? table?.read) : table?.[name ?? ''];
            try {
              if (!fn || !['get', 'set', 'delete', 'read', 'readFile'].includes(name ?? '')) {
                throw new Error('broker denied');
              }
              let value = await fn.apply(target, call.args);
              if (name === 'readFile' && value && typeof value === 'object' && 'status' in (value as object)) {
                const result = value as { status: string; text?: string };
                value = result.status === 'ok' ? result.text : result;
              }
              replies.push({ id: call.id, value });
            } catch (error) {
              replies.push({ id: call.id, error: error instanceof Error ? error.message : String(error) });
            }
          }
          resume = true;
        }
      };
      const run = (queues.get(id) ?? Promise.resolve()).then(work, work);
      queues.set(
        id,
        run.catch(() => {}),
      );
      return run;
    },
    async unload(id: string): Promise<void> {
      await queues.get(id);
      queues.delete(id);
      specs.delete(id);
      delete admissions[id];
      const slot = group.get(id);
      group.delete(id);
      ids.delete(id);
      if (slot && slot !== FIRST_PARTY_SLOT) {
        await rpc({ op: 'remove', plugin: slot }).catch(() => {});
      }
      if (slot === FIRST_PARTY_SLOT && ![...group.values()].includes(FIRST_PARTY_SLOT)) {
        ids.delete(FIRST_PARTY_SLOT);
        await rpc({ op: 'remove', plugin: FIRST_PARTY_SLOT }).catch(() => {});
      }
    },
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.allSettled([...queues.values()]);
      for (const id of [...specs.keys()]) await this.unload(id);
      budgets.dispose();
      unsubscribeExit?.();
      await transport?.close().catch(() => {});
      transport = undefined;
      ready = undefined;
      ids.clear();
    },
    stats(): IsolatedStats {
      return {
        kind: 'isolated',
        hardLimits: true,
        calls,
        plugins: specs.size,
        loads,
        pressureScale: budgets.scale(),
        ...(transport?.pid === undefined ? {} : { pid: transport.pid }),
        restarts,
        down,
        services: {
          storage: 'brokered',
          projectRead: 'brokered',
          submitCommitted: true,
          projectFileChange: true,
        },
        admissions: { ...admissions },
        cpuAccounting: 'thread-cputime',
        responseBytes: LIMITS.responseBytes,
        maxEffects: LIMITS.effectsPerCall,
        transport: 'real-rquickjs-process',
      };
    },
  };
}

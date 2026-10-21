// Trusted in-process executor. Async scheduling is not CPU or memory isolation
// (lesson 48): it cannot preempt a loop or cap RSS (`hardLimits: false`). For
// built-ins only. A time budget checked after a call returns cannot stop a
// hung call (lesson 23); late and cancelled results are dropped.

import type { Clock, Plugin, PluginContext, PluginHook } from '@murmo/api';
import type { ExecutionOptions, Executor, PluginDescriptor, PluginSpec } from '@murmo/api/adapter';
import { HOOKS } from '@murmo/api/adapter';
import { type BudgetPolicyOptions, createBudgetPolicy } from './budget.ts';
import { createClock } from './clock.ts';
import { executorFault } from './fault.ts';

const hookNames = Object.keys(HOOKS) as PluginHook[];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function descriptorOf(id: string, plugin: Plugin): PluginDescriptor {
  let keys: PluginDescriptor['keys'];
  try {
    keys = clone(plugin.keys ?? []);
  } catch {
    throw new Error('invalid declarative key claim');
  }
  if (!Array.isArray(keys) || keys.some((claim) => typeof claim === 'function')) {
    throw new Error('invalid declarative key claim');
  }
  return {
    id,
    name: String(plugin.name),
    version: String(plugin.version),
    permissions: [...(plugin.permissions ?? [])],
    guard: plugin.guard === true,
    keys,
    actions: [...(plugin.actions ?? [])],
    hooks: hookNames.filter((hook) => typeof plugin[hook] === 'function'),
  };
}

export interface InProcessStats {
  readonly kind: 'in-process';
  readonly hardLimits: false;
  readonly calls: number;
  readonly plugins: number;
  readonly loads: number;
  readonly pressureScale: number;
  readonly services: {
    readonly storage: 'brokered';
    readonly projectRead: 'brokered';
    readonly submitCommitted: true;
    readonly projectFileChange: true;
  };
  readonly admissions: Readonly<Record<string, number>>;
}

export interface InProcessExecutor extends Executor {
  readonly kind: 'in-process';
  stats(): InProcessStats;
}

export interface InProcessExecutorOptions extends BudgetPolicyOptions {
  readonly clock?: Clock;
}

interface Slot {
  readonly plugin: Plugin;
  readonly generation: number;
}

export function createInProcessExecutor(options: InProcessExecutorOptions = {}): InProcessExecutor {
  const budgets = createBudgetPolicy(options);
  const clock = options.clock ?? createClock();
  const plugins = new Map<string, Slot>();
  const admissions: Record<string, number> = {};
  let disposed = false;
  let calls = 0;
  let loads = 0;
  let nextGeneration = 1;

  const annotate = (error: unknown, id: string, hook: PluginHook | 'load', generation: number): never => {
    const extra = { pluginId: id, hook, generation, invocationId: calls };
    if (error && typeof error === 'object' && 'code' in error) {
      throw Object.assign(error, extra);
    }
    throw Object.assign(
      executorFault('exception', error instanceof Error ? error.message : String(error), extra),
      extra,
    );
  };

  return {
    kind: 'in-process',
    clock,
    async load(spec: PluginSpec): Promise<PluginDescriptor> {
      if (disposed) throw new Error('disposed');
      if (plugins.has(spec.id)) {
        throw new Error(`plugin identity ${JSON.stringify(spec.id)} is already loaded`);
      }
      if (!spec.factory) throw new Error('trusted Executor needs factory');
      await Promise.resolve();
      try {
        const plugin = spec.factory(spec.settings ?? {});
        const descriptor = descriptorOf(spec.id, plugin);
        const generation = nextGeneration++;
        plugins.set(spec.id, { plugin, generation });
        loads++;
        const memory = spec.resources?.memoryMiB;
        if (memory !== undefined) admissions[spec.id] = memory;
        return descriptor;
      } catch (error) {
        return annotate(error, spec.id, 'load', 0);
      }
    },
    async run(
      id: string,
      hook: PluginHook,
      input: unknown,
      ctx: PluginContext,
      runOptions: ExecutionOptions,
    ): Promise<unknown> {
      try {
        await budgets.sample();
        if (disposed || runOptions.signal?.cancelled) throw executorFault('cancelled', 'cancelled');
        const slot = plugins.get(id);
        if (!slot) throw new Error('plugin unloaded');
        const fn = slot.plugin[hook] as ((...args: unknown[]) => unknown) | undefined;
        if (typeof fn !== 'function') return undefined;
        calls++;
        const timeoutMs = runOptions.timeoutMs * budgets.scale();
        const start = clock.now();
        const args = hook === 'activate' ? [ctx] : hook === 'deactivate' ? [] : [input, ctx];
        const returned = fn.apply(slot.plugin, args);
        if (clock.now() - start > timeoutMs) throw executorFault('timeout', 'deadline exceeded');
        if (!returned || typeof (returned as { then?: unknown }).then !== 'function') {
          if (runOptions.signal?.cancelled) throw executorFault('cancelled', 'cancelled');
          return returned;
        }
        let cancel = (): void => {};
        const remaining = Math.max(0, timeoutMs - (clock.now() - start));
        const deadline = new Promise<never>((_, reject) => {
          cancel = clock.setTimer(() => reject(executorFault('timeout', 'deadline exceeded')), remaining);
        });
        try {
          const result = await Promise.race([returned as Promise<unknown>, deadline]);
          if (runOptions.signal?.cancelled) throw executorFault('cancelled', 'cancelled');
          return result;
        } finally {
          cancel();
        }
      } catch (error) {
        return annotate(error, id, hook, plugins.get(id)?.generation ?? 0);
      }
    },
    async unload(id: string): Promise<void> {
      const slot = plugins.get(id);
      plugins.delete(id);
      delete admissions[id];
      try {
        await slot?.plugin.deactivate?.();
      } catch {
        // A plugin that fails to deactivate is gone anyway.
      }
    },
    async dispose(): Promise<void> {
      disposed = true;
      budgets.dispose();
      for (const id of [...plugins.keys()]) await this.unload(id);
    },
    stats(): InProcessStats {
      return {
        kind: 'in-process',
        hardLimits: false,
        calls,
        plugins: plugins.size,
        loads,
        pressureScale: budgets.scale(),
        services: {
          storage: 'brokered',
          projectRead: 'brokered',
          submitCommitted: true,
          projectFileChange: true,
        },
        admissions: { ...admissions },
      };
    },
  };
}

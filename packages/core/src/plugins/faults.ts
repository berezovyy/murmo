// Typed fault strikes. Cancelled is not a fault. Missing `code` is skipped
// with a notice (never invented as an exception). `cpu`/`timeout` strike per
// hook and disable after LIMITS.faultStrikes in a row; a success resets.
// `memory`/`exception`/`output-limit` disable at once. `transport` degrades
// the executor and does not strike the plugin (r14-load proposal 5).

import type { PluginHook } from '@murmo/api';
import { LIMITS } from '@murmo/api';
import type { ExecutorFault, ExecutorFaultCode } from '@murmo/api/adapter';
import { codeOf } from '@murmo/executor';
import type { PluginEntry, RunnerHealth } from '../hooks.ts';

const budgetCodes: ReadonlySet<ExecutorFaultCode> = new Set(['cpu', 'timeout']);
const fatalCodes: ReadonlySet<ExecutorFaultCode> = new Set(['memory', 'exception', 'output-limit']);

export type FaultAction =
  | { readonly action: 'ignore' }
  | { readonly action: 'notice'; readonly message: string }
  | { readonly action: 'strike'; readonly message: string; readonly count: number; readonly disable: boolean }
  | { readonly action: 'disable'; readonly message: string }
  | { readonly action: 'degrade'; readonly message: string };

export class FaultBook {
  readonly #strikes = new Map<string, number>();
  #health: RunnerHealth = 'ok';

  health(): RunnerHealth {
    return this.#health;
  }

  markDown(): void {
    this.#health = 'down';
  }

  markDegraded(): void {
    if (this.#health === 'ok') this.#health = 'degraded';
  }

  success(plugin: PluginEntry, hook: PluginHook): void {
    this.#strikes.delete(`${plugin.id}\u0000${hook}`);
  }

  record(plugin: PluginEntry, hook: PluginHook, error: unknown): FaultAction {
    const code = codeOf(error);
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'cancelled') return { action: 'ignore' };
    if (code === undefined) {
      return { action: 'notice', message: `${plugin.name}: untyped executor fault; skipped without strike` };
    }
    if (code === 'transport') {
      this.markDegraded();
      return { action: 'degrade', message: `${plugin.name}: executor ${code}; plugin not struck` };
    }
    if (fatalCodes.has(code)) {
      return { action: 'disable', message: `${hook} failed: ${message}` };
    }
    if (budgetCodes.has(code)) {
      const key = `${plugin.id}\u0000${hook}`;
      const count = (this.#strikes.get(key) ?? 0) + 1;
      this.#strikes.set(key, count);
      const disable = count >= LIMITS.faultStrikes;
      return {
        action: 'strike',
        count,
        disable,
        message: disable
          ? `${LIMITS.faultStrikes} consecutive ${hook} budget failures: ${message}`
          : `${plugin.name}: ${hook} budget missed (${count}/${LIMITS.faultStrikes})`,
      };
    }
    return { action: 'disable', message: `${hook} failed: ${message}` };
  }

  strikes(pluginId: string, hook?: PluginHook): number {
    if (hook) return this.#strikes.get(`${pluginId}\u0000${hook}`) ?? 0;
    let total = 0;
    const prefix = `${pluginId}\u0000`;
    for (const [key, count] of this.#strikes) if (key.startsWith(prefix)) total += count;
    return total;
  }

  asFault(error: unknown, pluginId: string, hook: PluginHook): ExecutorFault {
    const code = codeOf(error) ?? 'exception';
    const message = error instanceof Error ? error.message : String(error);
    const generation = (error as { generation?: unknown } | null)?.generation;
    return {
      code,
      pluginId,
      hook,
      message,
      ...(typeof generation === 'number' ? { generation } : {}),
    };
  }
}

// At most one queued `onChange` per plugin: a newer change replaces the queued
// one so a slow plugin falls behind instead of piling up work (r14-load L5).

import { executorFault } from '@murmo/executor';
import type { HookCall } from '../hooks.ts';

interface Waiter {
  readonly call: HookCall;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

export class ChangeCoalescer {
  readonly #busy = new Set<string>();
  readonly #queued = new Map<string, Waiter>();

  async run(call: HookCall, execute: (call: HookCall) => Promise<unknown>): Promise<unknown> {
    if (call.hook !== 'onChange') return execute(call);
    const id = call.pluginId;
    if (this.#busy.has(id)) {
      const previous = this.#queued.get(id);
      if (previous) previous.reject(executorFault('cancelled', 'coalesced'));
      return new Promise<unknown>((resolve, reject) => {
        this.#queued.set(id, { call, resolve, reject });
      });
    }
    this.#busy.add(id);
    try {
      return await execute(call);
    } finally {
      this.#busy.delete(id);
      const next = this.#queued.get(id);
      if (next) {
        this.#queued.delete(id);
        void this.run(next.call, execute).then(next.resolve, next.reject);
      }
    }
  }
}

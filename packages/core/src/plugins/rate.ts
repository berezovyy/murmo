// Third-party edit rate: at most LIMITS.editsPerSecond applied edits per
// rolling second per plugin ID (r14 L6: 268 edits in 2 s never stopped).
// Built-ins are not capped here.

import type { Clock } from '@murmo/api';
import { LIMITS } from '@murmo/api';
import type { CommitGate, CommitRequest } from '../edits.ts';

const WINDOW_MS = 1_000;

export class EditRate implements CommitGate {
  readonly name = 'edit-rate';
  readonly #clock: Clock;
  readonly #applied = new Map<string, number[]>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  check(request: CommitRequest): string | null {
    if (request.plugin.builtin) return null;
    if (this.#window(request.plugin.id).length >= LIMITS.editsPerSecond) return 'edit-rate';
    return null;
  }

  noteApplied(pluginId: string, builtin: boolean): void {
    if (builtin) return;
    const now = this.#clock.now();
    const window = this.#window(pluginId);
    window.push(now);
    this.#applied.set(pluginId, window);
  }

  #window(pluginId: string): number[] {
    const now = this.#clock.now();
    return (this.#applied.get(pluginId) ?? []).filter((at) => now - at < WINDOW_MS);
  }
}

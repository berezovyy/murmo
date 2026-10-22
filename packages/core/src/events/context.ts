// Session-local next-prompt context. Deduped by plugin and id, consumed only
// on an authoritative accepted human prompt. A blocked submit keeps it;
// session end clears it. Never silently downgraded to the next tool step (E12).

import type { AgentActionResult, ContextTarget } from '@murmo/api/events';
import { unsupportedResult } from '@murmo/api/events';

export interface StagedContext {
  readonly pluginId: string;
  readonly id: string;
  readonly text: string;
  readonly target: ContextTarget;
  readonly expiresAtMs?: number;
}

export class ContextStager {
  readonly #items: StagedContext[] = [];
  readonly #targets: ReadonlySet<ContextTarget>;

  constructor(targets: readonly ContextTarget[] = []) {
    this.#targets = new Set(targets);
  }

  get size(): number {
    return this.#items.length;
  }

  supports(target: ContextTarget): boolean {
    return this.#targets.has(target);
  }

  stage(
    pluginId: string,
    text: string,
    options: { id?: string; expiresAfterMs?: number; target?: ContextTarget } = {},
    nowMs: number,
  ): AgentActionResult {
    const target = options.target ?? 'next-accepted-human-prompt';
    if (!this.#targets.has(target)) {
      return unsupportedResult(`context target ${target} is not advertised on this route`);
    }
    const id = options.id ?? 'default';
    const expiresAtMs = options.expiresAfterMs !== undefined ? nowMs + options.expiresAfterMs : undefined;
    const next: StagedContext = { pluginId, id, text, target, ...(expiresAtMs !== undefined ? { expiresAtMs } : {}) };
    const index = this.#items.findIndex((item) => item.pluginId === pluginId && item.id === id);
    if (index >= 0) this.#items[index] = next;
    else this.#items.push(next);
    return { status: 'applied' };
  }

  /** Consume matching rows. A blocked submit must not call this. */
  consume(target: ContextTarget, nowMs: number): string[] {
    const kept: StagedContext[] = [];
    const out: string[] = [];
    for (const item of this.#items) {
      if (item.expiresAtMs !== undefined && item.expiresAtMs <= nowMs) continue;
      if (item.target === target) out.push(item.text);
      else kept.push(item);
    }
    this.#items.length = 0;
    this.#items.push(...kept);
    return out;
  }

  /** Peek without consuming (blocked submit, doctor). */
  peek(target: ContextTarget, nowMs: number): string[] {
    return this.#items
      .filter((item) => item.target === target && (item.expiresAtMs === undefined || item.expiresAtMs > nowMs))
      .map((item) => item.text);
  }

  clear(): void {
    this.#items.length = 0;
  }
}

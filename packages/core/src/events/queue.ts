// Per-plugin observer FIFO. Barriers never enter this queue (plan/39 rule 3).
// Overflow coalesces message.delta only, then drops the oldest non-terminal
// observer events and records a delivery.gap with counts (E9).

import type { AgentEvent, AgentEventKind } from '@murmo/api/events';
import { EVENTS_LIMITS } from '@murmo/api/events';

const TERMINAL: ReadonlySet<AgentEventKind> = new Set([
  'session.end',
  'turn.end',
  'turn.error',
  'agent.run.end',
  'agent.idle',
  'tool.after',
  'tool.error',
  'compact.after',
  'subagent.end',
  'delivery.gap',
]);

export interface QueueLimits {
  readonly capacity: number;
  readonly bytes: number;
  readonly maxAgeMs: number;
}

export interface EnqueueResult {
  readonly dropped: number;
  readonly coalesced: number;
  readonly expired: number;
}

export class ObserverQueue {
  readonly #items: AgentEvent[] = [];
  #bytes = 0;
  readonly #limits: QueueLimits;
  #overflowSinceMs: number | undefined;
  #overflowStrikes = 0;

  constructor(
    limits: QueueLimits = {
      capacity: EVENTS_LIMITS.queueCapacity,
      bytes: EVENTS_LIMITS.queueBytes,
      maxAgeMs: EVENTS_LIMITS.maxAgeMs,
    },
  ) {
    this.#limits = {
      capacity: limits.capacity,
      bytes: limits.bytes,
      maxAgeMs: limits.maxAgeMs,
    };
  }

  get size(): number {
    return this.#items.length;
  }

  overflowingSince(): number | undefined {
    return this.#overflowSinceMs;
  }

  overflowStrikes(): number {
    return this.#overflowStrikes;
  }

  recordOverflowStrike(): number {
    this.#overflowStrikes += 1;
    return this.#overflowStrikes;
  }

  clearOverflowStrike(): void {
    this.#overflowStrikes = 0;
    this.#overflowSinceMs = undefined;
  }

  peek(): AgentEvent | undefined {
    return this.#items[0];
  }

  shift(): AgentEvent | undefined {
    const next = this.#items.shift();
    if (next) this.#bytes -= payloadBytes(next);
    if (this.#items.length === 0) this.#overflowSinceMs = undefined;
    return next;
  }

  expire(nowMs: number): number {
    let expired = 0;
    while (this.#items.length) {
      const head = this.#items[0];
      if (!head) break;
      const age = nowMs - head.receivedAtMs;
      if (age <= this.#limits.maxAgeMs) break;
      this.shift();
      expired += 1;
    }
    return expired;
  }

  push(event: AgentEvent, nowMs: number): EnqueueResult {
    const expired = this.expire(nowMs);
    let coalesced = 0;
    let dropped = 0;
    if (event.kind === 'message.delta') {
      let last = -1;
      for (let i = this.#items.length - 1; i >= 0; i--) {
        const item = this.#items[i];
        if (item && item.kind === 'message.delta' && sameDelta(item, event)) {
          last = i;
          break;
        }
      }
      if (last >= 0) {
        const prev = this.#items[last];
        if (prev) this.#bytes -= payloadBytes(prev);
        this.#items[last] = event;
        this.#bytes += payloadBytes(event);
        coalesced = 1;
        return { dropped, coalesced, expired };
      }
    }
    this.#items.push(event);
    this.#bytes += payloadBytes(event);
    while (this.#over()) {
      const index = this.#oldestDroppable();
      if (index < 0) break;
      const removed = this.#items.splice(index, 1)[0];
      if (removed) this.#bytes -= payloadBytes(removed);
      dropped += 1;
    }
    if (this.#over()) {
      this.#overflowSinceMs ??= nowMs;
    } else {
      this.#overflowSinceMs = undefined;
    }
    return { dropped, coalesced, expired };
  }

  #over(): boolean {
    return this.#items.length > this.#limits.capacity || this.#bytes > this.#limits.bytes;
  }

  #oldestDroppable(): number {
    for (let i = 0; i < this.#items.length; i++) {
      const item = this.#items[i];
      if (item && !TERMINAL.has(item.kind)) return i;
    }
    return this.#items.length ? 0 : -1;
  }
}

function sameDelta(a: AgentEvent, b: AgentEvent): boolean {
  return a.sessionId === b.sessionId && a.itemId === b.itemId && a.partId === b.partId;
}

export function payloadBytes(event: AgentEvent): number {
  try {
    return jsonUtf8Bytes(JSON.stringify(event));
  } catch {
    return 0;
  }
}

function jsonUtf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

// submit-committed delivery: 256-ID dedup, a 32-event observer queue, and
// commit levels. The hook has its own lifetime (not the cancellable key
// epoch); its effects stay bound to their version (lesson 72, E7).

import type {
  Clock,
  Draft,
  InputOriginEvidence,
  PluginHook,
  SubmitCommitted,
  SubmitGesture,
  SubmitUnresolved,
} from '@murmo/api';
import type { HostSubmitAccepted } from '@murmo/api/adapter';
import type { PluginEntry } from '../hooks.ts';
import { projectCommittedText } from './project.ts';
import { COMMIT_WINDOW_MS, COMMITTED_DEDUP, OBSERVER_QUEUE, type SubmitAccess } from './types.ts';

export type CommitResolution = 'observed' | 'inferred' | 'unknown';

export interface PendingForward {
  readonly submissionId: string;
  readonly gesture: SubmitGesture;
  readonly text: string;
  readonly position: SubmitCommitted['position'];
  readonly typedSpans: SubmitCommitted['typedSpans'];
  readonly forwardedAt: number;
}

export interface DeliveryDeps {
  readonly clock: Clock;
  readonly access: SubmitAccess;
  readonly evidence: InputOriginEvidence;
  readonly plugins: () => readonly PluginEntry[];
  readonly commitWindowMs: number;
  readonly alive: () => boolean;
  readonly schedule: (plugin: PluginEntry, hook: PluginHook, input: unknown) => Promise<void>;
  readonly onResolved: (level: CommitResolution) => void;
  readonly onOverflow: () => void;
}

interface Queued {
  readonly hook: 'onSubmitCommitted' | 'onSubmitUnresolved';
  readonly input: SubmitCommitted | SubmitUnresolved;
}

export class CommitDelivery {
  readonly #deps: DeliveryDeps;
  readonly #seen = new Set<string>();
  readonly #queues = new Map<string, Queued[]>();
  readonly #busy = new Set<string>();
  #pending: PendingForward | null = null;
  #cancelWindow: (() => void) | undefined;
  #inferred = 0;
  #keySinceForward = false;

  constructor(deps: DeliveryDeps) {
    this.#deps = deps;
  }

  get pending(): PendingForward | null {
    return this.#pending;
  }

  /** A send/replace left the pipeline; wait for accept, a clear, a key, or the window. */
  arm(forward: PendingForward): void {
    this.#cancel();
    this.#pending = forward;
    this.#keySinceForward = false;
    const ms = this.#deps.commitWindowMs > 0 ? this.#deps.commitWindowMs : COMMIT_WINDOW_MS;
    this.#cancelWindow = this.#deps.clock.setTimer(() => this.unresolved(), ms);
  }

  /** The adapter saw the host accept this submission (`level: observed`). */
  noteAccepted(event: HostSubmitAccepted): void {
    if ((event.gesture as string) === 'newline') return;
    if (this.#dropDuplicate(event.submissionId)) return;
    this.#clearPending();
    const committed: SubmitCommitted = { ...event, level: 'observed' };
    this.#deps.onResolved('observed');
    this.#deliverCommitted(committed);
  }

  /**
   * The host's draft changed after a forward. An empty composer with no key
   * in between is `inferred`; anything else while pending is `unknown`.
   */
  noteChange(draft: Draft, committed: 'none' | 'accepted-text'): void {
    const pending = this.#pending;
    if (!pending) return;
    if (draft.certainty === 'unknown') {
      this.unresolved();
      return;
    }
    if (committed === 'accepted-text') return;
    if (this.#keySinceForward) {
      this.unresolved();
      return;
    }
    if (draft.text === '') {
      if (this.#dropDuplicate(pending.submissionId)) {
        this.#clearPending();
        return;
      }
      const event: SubmitCommitted = {
        text: pending.text,
        gesture: pending.gesture,
        submissionId: pending.submissionId,
        position: pending.position,
        level: 'inferred',
        ...(pending.typedSpans ? { typedSpans: pending.typedSpans } : {}),
      };
      this.#clearPending();
      this.#deps.onResolved('inferred');
      this.#deliverCommitted(event);
      return;
    }
    this.unresolved();
  }

  /** A user key while a forward is unresolved: cannot infer (Ctrl+C trap, E17). */
  noteKey(): void {
    if (!this.#pending) return;
    this.#keySinceForward = true;
    this.unresolved();
  }

  unresolved(): void {
    const pending = this.#pending;
    if (!pending) return;
    const event: SubmitUnresolved = { submissionId: pending.submissionId, gesture: pending.gesture };
    this.#clearPending();
    this.#deps.onResolved('unknown');
    this.#deliverUnresolved(event);
  }

  nextInferredId(): string {
    return `inferred-${++this.#inferred}`;
  }

  dispose(): void {
    this.#cancel();
    this.#pending = null;
    this.#queues.clear();
    this.#busy.clear();
  }

  #dropDuplicate(id: string): boolean {
    if (this.#seen.has(id)) return true;
    this.#seen.add(id);
    if (this.#seen.size > COMMITTED_DEDUP) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return false;
  }

  #clearPending(): void {
    this.#cancel();
    this.#pending = null;
    this.#keySinceForward = false;
  }

  #cancel(): void {
    this.#cancelWindow?.();
    this.#cancelWindow = undefined;
  }

  #deliverCommitted(event: SubmitCommitted): void {
    const { access, evidence } = this.#deps;
    for (const plugin of this.#deps.plugins()) {
      if (plugin.disabled || !plugin.hooks.has('onSubmitCommitted') || !access.mayObserve(plugin)) continue;
      if (!access.holds(plugin, 'draft:read')) continue;
      const text = projectCommittedText(event.text, event.typedSpans, plugin, access, evidence);
      this.#enqueue(plugin, { hook: 'onSubmitCommitted', input: { ...event, text } });
    }
  }

  #deliverUnresolved(event: SubmitUnresolved): void {
    for (const plugin of this.#deps.plugins()) {
      if (plugin.disabled || !plugin.hooks.has('onSubmitUnresolved') || !this.#deps.access.mayObserve(plugin)) {
        continue;
      }
      this.#enqueue(plugin, { hook: 'onSubmitUnresolved', input: event });
    }
  }

  #enqueue(plugin: PluginEntry, item: Queued): void {
    let queue = this.#queues.get(plugin.id);
    if (!queue) {
      queue = [];
      this.#queues.set(plugin.id, queue);
    }
    queue.push(item);
    while (queue.length > OBSERVER_QUEUE) {
      queue.shift();
      this.#deps.onOverflow();
    }
    void this.#drain(plugin);
  }

  async #drain(plugin: PluginEntry): Promise<void> {
    if (this.#busy.has(plugin.id)) return;
    this.#busy.add(plugin.id);
    try {
      const queue = this.#queues.get(plugin.id);
      if (!queue) return;
      while (queue.length && this.#deps.alive()) {
        const item = queue.shift();
        if (!item) break;
        await this.#deps.schedule(plugin, item.hook, item.input);
      }
    } finally {
      this.#busy.delete(plugin.id);
    }
  }
}

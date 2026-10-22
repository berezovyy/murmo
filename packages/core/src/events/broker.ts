// Event broker: per-plugin bounded queues, fail-open (or owned fail-closed)
// guard slots, context staging, ghost proposals. Barriers never queue behind
// observers. Late denials are never sent (E4).

import type { Capabilities, Clock, Draft, HostName, HostState, Permission, PluginContext } from '@murmo/api';
import { LIMITS } from '@murmo/api';
import type {
  AgentApi,
  AgentCapabilities,
  AgentContext,
  AgentEvent,
  AgentEventKind,
  AgentEventResult,
  BlockDecision,
  ContextTarget,
  ContinueDecision,
  EventCapability,
  EventDecision,
  GhostProposal,
} from '@murmo/api/events';
import {
  EVENTS_GUARD_BUDGET_MS,
  EVENTS_LIMITS,
  isBarrierKind,
  isEventPermission,
  unsupportedResult,
} from '@murmo/api/events';
import { ContextStager } from './context.ts';
import { GhostBroker, type GhostSink } from './ghost.ts';
import { ObserverQueue } from './queue.ts';

export type EventFaultCode = 'guard-timeout' | 'queue-overflow' | 'expired' | 'permission';

export interface EventFault {
  readonly code: EventFaultCode;
  readonly pluginId: string;
  readonly message: string;
}

export interface EventPluginRef {
  readonly id: string;
  readonly builtin: boolean;
  readonly permissions: readonly Permission[];
  readonly events?: readonly AgentEventKind[];
  readonly disabled?: boolean;
}

export type EventDispatch = (
  plugin: EventPluginRef,
  event: AgentEvent,
  ctx: AgentContext,
  timeoutMs: number,
  signal: CancellationFlag,
) => AgentEventResult | Promise<AgentEventResult>;

export interface CancellationFlag {
  cancelled: boolean;
}

export interface EventBrokerOptions {
  readonly clock: Clock;
  readonly host: HostName;
  readonly hostVersion: string;
  readonly caps: AgentCapabilities;
  readonly plugins: () => readonly EventPluginRef[];
  readonly dispatch: EventDispatch;
  readonly draft: () => Draft;
  readonly state: () => HostState;
  readonly ghost: GhostSink;
  readonly sessionId: () => string;
  readonly onFault?: (fault: EventFault) => void;
  /** Where Murmo owns the barrier (Pi). Host command hooks ignore this and fail open. */
  readonly ownedBarrierFailure?: 'allow' | 'deny';
  readonly guardBudgetMs?: number;
  readonly hostCaps: Capabilities;
  readonly storage?: PluginContext['storage'];
  readonly project?: PluginContext['project'];
}

const CONTINUE: ContinueDecision = { action: 'continue' };

export class EventBroker {
  readonly #options: EventBrokerOptions;
  readonly #queues = new Map<string, ObserverQueue>();
  readonly #draining = new Map<string, Promise<void>>();
  readonly #context: ContextStager;
  readonly #ghost = new GhostBroker();
  readonly #disabled = new Set<string>();
  #sequence = 0;
  #busy = 0;
  readonly #sessionId: string;

  constructor(options: EventBrokerOptions) {
    this.#options = options;
    this.#sessionId = options.sessionId();
    this.#ghost.noteSession(this.#sessionId);
    this.#context = new ContextStager(options.caps.contextTargets ?? []);
  }

  agentApi(pluginId: string): AgentApi {
    const caps = this.#options.caps;
    return {
      caps,
      addNextPromptContext: (text, options) =>
        Promise.resolve(this.#context.stage(pluginId, text, options, this.#options.clock.now())),
      addContext: (text, options) =>
        Promise.resolve(
          this.#context.stage(
            pluginId,
            text,
            {
              ...(options.id === undefined ? {} : { id: options.id }),
              ...(options.expiresAfterMs === undefined ? {} : { expiresAfterMs: options.expiresAfterMs }),
              target: options.target,
            },
            this.#options.clock.now(),
          ),
        ),
      sendPrompt: async () => unsupportedResult('agent:send is off in the events preview'),
    };
  }

  noteTypedKey(): void {
    this.#ghost.noteTypedKey();
  }

  consumeContext(target: ContextTarget): string[] {
    return this.#context.consume(target, this.#options.clock.now());
  }

  peekContext(target: ContextTarget): string[] {
    return this.#context.peek(target, this.#options.clock.now());
  }

  clearContext(): void {
    this.#context.clear();
  }

  disabled(): ReadonlySet<string> {
    return this.#disabled;
  }

  faults: EventFault[] = [];

  /**
   * Barrier decision without awaiting a Promise. A Promise result is a timeout
   * (fail-open): the Codex `murmo hook` path is synchronous in the wrapper.
   */
  decideSync(partial: Omit<AgentEvent, 'sequence' | 'receivedAtMs'> & { receivedAtMs?: number }): EventDecision {
    const receivedAtMs = partial.receivedAtMs ?? this.#options.clock.now();
    const event: AgentEvent = { ...partial, sequence: ++this.#sequence, receivedAtMs };
    const cap = this.#options.caps.events[event.kind];
    if (!cap || cap.evidence === 'source' || cap.evidence === 'replay' || cap.delivery === 'unsupported') {
      return CONTINUE;
    }
    if (!isBarrierKind(event.kind, cap)) {
      this.#enqueue(event);
      void this.#pump();
      return CONTINUE;
    }
    const permission: Permission =
      event.kind === 'tool.before' || event.kind === 'permission.request' ? 'tools:guard' : 'events:read';
    let decision: EventDecision = CONTINUE;
    const signal: CancellationFlag = { cancelled: false };
    for (const plugin of this.#subscribers(event.kind, permission)) {
      const ctx = this.#contextFor(plugin, event, signal);
      const delivered = withFreshness(event, this.#options.clock.now());
      const result = this.#options.dispatch(plugin, delivered, ctx, 0, signal);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        this.#fault({
          code: 'guard-timeout',
          pluginId: plugin.id,
          message: 'async guard on a sync hook path; fail-open continue',
        });
        continue;
      }
      const picked = asDecision(result as AgentEventResult);
      if (picked?.action === 'block') decision = picked;
      else if (picked && decision.action !== 'block' && picked.action !== 'continue') decision = picked;
    }
    return decision;
  }

  /**
   * Ingest a native-normalized event. Barrier kinds wait for a decision inside
   * the guard budget; observers are queued per plugin.
   */
  async ingest(
    partial: Omit<AgentEvent, 'sequence' | 'receivedAtMs'> & { receivedAtMs?: number },
  ): Promise<EventDecision> {
    const receivedAtMs = partial.receivedAtMs ?? this.#options.clock.now();
    const event: AgentEvent = {
      ...partial,
      sequence: ++this.#sequence,
      receivedAtMs,
    };
    this.#ghost.noteSession(event.sessionId);
    if (event.kind === 'agent.run.start') this.#ghost.noteNewRun();
    if (event.kind === 'session.end') this.#context.clear();

    const cap = this.#options.caps.events[event.kind];
    if (!cap || cap.evidence === 'source' || cap.evidence === 'replay' || cap.delivery === 'unsupported') {
      return CONTINUE;
    }
    if (isBarrierKind(event.kind, cap)) {
      return this.#barrier(event, cap);
    }
    this.#enqueue(event);
    if (event.kind === 'agent.idle') {
      await this.#pump();
      await this.#flushIdle(event);
    } else {
      void this.#pump();
    }
    return CONTINUE;
  }

  #subscribers(kind: AgentEventKind, permission: Permission): EventPluginRef[] {
    return this.#options.plugins().filter((plugin) => {
      if (!plugin.builtin) return false;
      if (plugin.disabled || this.#disabled.has(plugin.id)) return false;
      if (plugin.events && !plugin.events.includes(kind)) return false;
      return plugin.permissions.includes(permission);
    });
  }

  async #barrier(event: AgentEvent, cap: EventCapability): Promise<EventDecision> {
    const permission: Permission =
      event.kind === 'tool.before' || event.kind === 'permission.request' ? 'tools:guard' : 'events:read';
    const plugins = this.#subscribers(event.kind, permission);
    const budget = this.#options.guardBudgetMs ?? EVENTS_GUARD_BUDGET_MS;
    const fail =
      cap.failure === 'deny'
        ? 'deny'
        : this.#options.ownedBarrierFailure === 'deny' && cap.failure !== 'allow'
          ? 'deny'
          : 'allow';
    const owned = cap.failure === 'deny' || this.#options.ownedBarrierFailure === 'deny';
    const policy = cap.failure === 'allow' ? 'allow' : owned && fail === 'deny' ? 'deny' : cap.failure;
    let decision: EventDecision = CONTINUE;
    const start = this.#options.clock.now();
    for (const plugin of plugins) {
      const remaining = budget - (this.#options.clock.now() - start);
      if (remaining <= 0) {
        this.#fault({
          code: 'guard-timeout',
          pluginId: plugin.id,
          message: `guard budget ${budget} ms exhausted; ${policy === 'deny' ? 'blocking' : 'allowing'}`,
        });
        break;
      }
      const signal: CancellationFlag = { cancelled: false };
      const result = await this.#timed(plugin, event, remaining, signal);
      if (signal.cancelled || result === 'timeout') {
        this.#fault({
          code: 'guard-timeout',
          pluginId: plugin.id,
          message: `guard-timeout on ${event.kind}; late deny discarded`,
        });
        continue;
      }
      const picked = asDecision(result);
      if (picked?.action === 'block') decision = picked;
      else if (picked && decision.action !== 'block' && picked.action !== 'continue') decision = picked;
      this.#maybeGhost(plugin.id, result);
      await this.#maybeContext(plugin.id, result);
    }
    if (this.#options.clock.now() - start >= budget) {
      this.#fault({
        code: 'guard-timeout',
        pluginId: '*',
        message: `guard-timeout; ${policy === 'deny' ? 'fail-closed block' : 'fail-open continue'}`,
      });
      if (policy === 'deny') return { action: 'block', reason: 'guard timed out' } satisfies BlockDecision;
      return CONTINUE;
    }
    return decision;
  }

  async #timed(
    plugin: EventPluginRef,
    event: AgentEvent,
    timeoutMs: number,
    signal: CancellationFlag,
  ): Promise<AgentEventResult | 'timeout'> {
    const ctx = this.#contextFor(plugin, event, signal);
    let cancel = (): void => {};
    const timeout = new Promise<'timeout'>((resolve) => {
      cancel = this.#options.clock.setTimer(
        () => {
          signal.cancelled = true;
          resolve('timeout');
        },
        Math.max(0, timeoutMs),
      );
    });
    try {
      const delivered = withFreshness(event, this.#options.clock.now());
      return await Promise.race([this.#options.dispatch(plugin, delivered, ctx, timeoutMs, signal), timeout]);
    } catch (error) {
      this.#fault({
        code: 'permission',
        pluginId: plugin.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      cancel();
    }
  }

  #enqueue(event: AgentEvent): void {
    const observers = this.#subscribers(event.kind, 'events:read');
    for (const plugin of observers) {
      const queue = this.#queue(plugin.id);
      const now = this.#options.clock.now();
      const result = queue.push(event, now);
      if (result.dropped || result.expired || result.coalesced) {
        const gap: AgentEvent = {
          kind: 'delivery.gap',
          host: event.host,
          sessionId: event.sessionId,
          sequence: ++this.#sequence,
          receivedAtMs: now,
          sourceEvent: 'murmo.queue',
          gap: { dropped: result.dropped, coalesced: result.coalesced, expired: result.expired },
        };
        queue.push(gap, now);
      }
      const since = queue.overflowingSince();
      if (since !== undefined && now - since >= EVENTS_LIMITS.overflowFaultMs) {
        const strikes = queue.recordOverflowStrike();
        this.#fault({
          code: 'queue-overflow',
          pluginId: plugin.id,
          message: `observer queue overflowing for ${EVENTS_LIMITS.overflowFaultMs} ms (${strikes}/${LIMITS.faultStrikes})`,
        });
        queue.clearOverflowStrike();
        if (strikes >= LIMITS.faultStrikes) this.#disabled.add(plugin.id);
      }
    }
  }

  async #pump(): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const plugin of this.#options.plugins()) {
      const queue = this.#queues.get(plugin.id);
      if (!queue || queue.size === 0) continue;
      let job = this.#draining.get(plugin.id);
      if (!job) {
        job = this.#drain(plugin, queue).finally(() => this.#draining.delete(plugin.id));
        this.#draining.set(plugin.id, job);
      }
      jobs.push(job);
    }
    if (jobs.length) await Promise.all(jobs);
  }

  async #drain(plugin: EventPluginRef, queue: ObserverQueue): Promise<void> {
    this.#busy += 1;
    try {
      while (queue.size) {
        const now = this.#options.clock.now();
        const expired = queue.expire(now);
        if (expired) {
          this.#fault({
            code: 'expired',
            pluginId: plugin.id,
            message: `dropped ${expired} observer events older than maxAgeMs`,
          });
        }
        const event = queue.shift();
        if (!event) break;
        if (now - event.receivedAtMs > EVENTS_LIMITS.maxAgeMs && event.kind !== 'delivery.gap') continue;
        const signal: CancellationFlag = { cancelled: false };
        const result = await this.#timed(plugin, event, EVENTS_LIMITS.maxAgeMs, signal);
        if (result === 'timeout') continue;
        this.#maybeGhost(plugin.id, result);
        await this.#maybeContext(plugin.id, result);
      }
    } finally {
      this.#busy -= 1;
    }
  }

  async #flushIdle(event: AgentEvent): Promise<void> {
    const now = this.#options.clock.now();
    await this.#ghost.applyIfReady(now, this.#options.draft(), this.#options.state(), this.#options.ghost);
    void event;
  }

  #maybeGhost(pluginId: string, result: AgentEventResult | 'timeout'): void {
    if (!result || result === 'timeout' || Array.isArray(result)) return;
    if ((result as GhostProposal).action === 'propose-ghost') {
      this.#ghost.hold(pluginId, result as GhostProposal);
    }
  }

  async #maybeContext(pluginId: string, result: AgentEventResult | 'timeout'): Promise<void> {
    void pluginId;
    void result;
  }

  #queue(pluginId: string): ObserverQueue {
    let queue = this.#queues.get(pluginId);
    if (!queue) {
      queue = new ObserverQueue();
      this.#queues.set(pluginId, queue);
    }
    return queue;
  }

  #contextFor(plugin: EventPluginRef, _event: AgentEvent, signal: CancellationFlag): AgentContext {
    return {
      host: {
        name: this.#options.host,
        version: this.#options.hostVersion,
        caps: this.#options.hostCaps,
      },
      draft: this.#options.draft(),
      state: this.#options.state(),
      settings: {},
      signal,
      clock: this.#options.clock,
      storage: this.#options.storage ?? {
        get: async () => ({ status: 'ok' as const }),
        set: async () => ({ status: 'ok' as const }),
        delete: async () => ({ status: 'ok' as const }),
      },
      project: this.#options.project ?? {
        read: async () => ({ status: 'denied' as const, reason: 'events plugins have no implicit filesystem' }),
      },
      agent: this.agentApi(plugin.id),
    };
  }

  #fault(fault: EventFault): void {
    this.faults.push(fault);
    this.#options.onFault?.(fault);
  }
}

function withFreshness(event: AgentEvent, nowMs: number): AgentEvent {
  return {
    ...event,
    freshness: {
      deliveredAtMs: nowMs,
      queueAgeMs: nowMs - event.receivedAtMs,
      ...(event.freshness?.expiresAtMs !== undefined ? { expiresAtMs: event.freshness.expiresAtMs } : {}),
    },
  };
}

function asDecision(result: AgentEventResult | 'timeout'): EventDecision | undefined {
  if (!result || result === 'timeout' || Array.isArray(result)) return undefined;
  if (typeof result === 'object' && 'action' in result && result.action !== 'propose-ghost') {
    return result as EventDecision;
  }
  return undefined;
}

export function hasGrant(plugin: EventPluginRef, permission: Permission): boolean {
  if (isEventPermission(permission)) return plugin.permissions.includes(permission);
  return plugin.permissions.includes(permission);
}

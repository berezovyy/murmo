// The plugin contract. A plugin is a plain object returned by a factory; every
// hook is asynchronous from the host's point of view and receives JSON snapshots
// that are immutable by contract. No adapter or ambient host object is supplied.

import type { PluginStorage, ProjectAccess, ProjectChange } from './brokers.ts';
import type { Capabilities } from './caps.ts';
import type { Change, Draft, HostName, HostState, Range, SubmitGesture } from './draft.ts';
import type { Effect, MenuItem } from './effects.ts';
import type { KeyClaim, PluginAction } from './keys.ts';
import type { Permission } from './limits.ts';
import type { Negotiation } from './manifest.ts';

export interface Cancellation {
  /** True once the result can no longer apply; check it before and after every await. */
  readonly cancelled: boolean;
}

/** Injected time: guests have no timers of their own. */
export interface Clock {
  /** Monotonic milliseconds, for elapsed time only. */
  now(): number;
  /** Unix wall time in milliseconds, for calendar work (UTC days). */
  wallTimeMs(): number;
  /** Returns a function that cancels the timer. */
  setTimer(callback: () => void, ms: number): () => void;
  sleep(ms: number, signal?: Cancellation): Promise<void>;
}

export interface PluginContext {
  /** Present when the plugin was loaded with a manifest. */
  readonly negotiation?: Negotiation;
  readonly host: { readonly name: HostName; readonly version: string; readonly caps: Capabilities };
  /** The current draft; masked to typed spans unless the plugin holds `draft:read:full`. */
  readonly draft: Draft;
  readonly state: HostState;
  /** The change that caused this call, for `onChange`. */
  readonly change?: Change;
  /** Settings resolved against the manifest schema, copied per call. */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly signal: Cancellation;
  readonly clock: Clock;
  readonly storage: PluginStorage;
  /** Returns `denied` unless `fs:project-read` is declared, granted and approved. */
  readonly project: ProjectAccess;
}

/** A plugin's answer to a submit attempt. `newline` never reaches this hook. */
export type SubmitDecision =
  | { readonly action: 'send' }
  /** Built-ins only; from any other plugin a changed text blocks with a diagnostic. */
  | { readonly action: 'replace'; readonly text: string }
  | { readonly action: 'block'; readonly reason: string };

export type SubmitPosition = 'managed' | 'final-boundary';

export interface SubmitTransaction {
  readonly draft: Draft;
  readonly gesture: SubmitGesture;
  /** Where this call runs relative to native peer transforms; managed is never final. */
  readonly position: SubmitPosition;
}

/**
 * How sure the core is that a submission was accepted:
 * - `observed`: the adapter saw the host accept it (`caps.submit.committed: 'accepted-text'`).
 * - `inferred`: no acceptance signal, but the core forwarded the send and the
 *   host cleared the draft with no key in between. On a managed host a native
 *   peer may have changed what was really sent.
 */
export type CommitLevel = 'observed' | 'inferred';

/**
 * Delivered at most once per submission, after the host accepted the prompt;
 * never for a block, a failure or a newline. No journal or retry: a crash or
 * dispose can lose it. For `queue`, accepted means queued by the host, which the
 * user may still cancel.
 */
export interface SubmitCommitted {
  readonly text: string;
  readonly gesture: SubmitGesture;
  readonly submissionId: string;
  readonly position: SubmitPosition;
  readonly level: CommitLevel;
  /** Host acceptance time in Unix ms, absent when the adapter can't supply it. Not provider time. */
  readonly acceptedAtMs?: number;
  readonly typedSpans?: readonly Range[];
}

/**
 * A submission the core let through but could not resolve: no acceptance, no
 * clear, or a key came first. "Not sent" and "can't tell" differ: this is the
 * second.
 */
export interface SubmitUnresolved {
  readonly submissionId: string;
  readonly gesture: SubmitGesture;
}

/** What an effect-producing hook returns. */
export type HookEffects = readonly Effect[] | undefined;

type Async<T> = T | Promise<T>;

export interface Plugin {
  readonly name: string;
  readonly version: string;
  /** Must be a subset of the manifest's declared permissions. */
  readonly permissions: readonly Permission[];
  /** A guard blocks the send whenever it fails, times out or lacks its permission. */
  readonly guard?: boolean;
  readonly keys?: readonly KeyClaim[];
  readonly actions?: readonly PluginAction[];

  activate?(ctx: PluginContext): Async<HookEffects>;
  /** Needs `draft:read` or `draft:read:full`. */
  onChange?(change: Change, ctx: PluginContext): Async<HookEffects>;
  /** Runs after the claim decision for `dispatch` claims; its result can't consume the key. */
  onKey?(key: string, ctx: PluginContext): Async<HookEffects>;
  /** The user picked one of this plugin's menu rows (by opaque `id`). */
  onMenuSelect?(item: MenuItem, ctx: PluginContext): Async<HookEffects>;
  /** A declared logical action, e.g. `murmo.menu`. */
  onAction?(action: PluginAction, ctx: PluginContext): Async<HookEffects>;
  /** Needs `submit`. Runs for send, queue and steer before the host clears the draft. */
  onBeforeSubmit?(tx: SubmitTransaction, ctx: PluginContext): Async<SubmitDecision>;
  /** Needs `submit:observe`. Survives later typing; its effects stay bound to their version. */
  onSubmitCommitted?(event: SubmitCommitted, ctx: PluginContext): Async<HookEffects>;
  /** Needs `submit:observe`. */
  onSubmitUnresolved?(event: SubmitUnresolved, ctx: PluginContext): Async<HookEffects>;
  /** Needs `fs:project-read`. */
  onProjectFileChange?(event: ProjectChange, ctx: PluginContext): Async<HookEffects>;
  /**
   * Agent-loop events (`@murmo/api/events`). Needs `events:read`. Typed as
   * `AgentEvent` / `AgentContext` on `AgentPlugin`; the executor passes JSON.
   */
  onAgentEvent?(event: unknown, ctx: PluginContext): unknown;
  deactivate?(): Async<void>;
}

/** Settings arrive already resolved against the manifest's settings schema. */
export type PluginFactory = (settings: Readonly<Record<string, unknown>>) => Plugin;

/** Names of every function-valued member of a plugin shape. */
export type HookNames<P> = {
  [K in keyof P]-?: NonNullable<P[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof P];

/** Names of the plugin hooks. */
export type PluginHook = HookNames<Plugin>;

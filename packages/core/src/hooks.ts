// The seam between the session and plugin code. The session never calls a
// plugin itself: it asks a HookRunner to run one hook and gets the raw result
// back. Phase 05 ships a direct runner for tests (`@murmo/core/testing`);
// phase 09 replaces it with the real executors, which add deadlines,
// permissions and grants, brokers and typed fault strikes.

import type {
  Cancellation,
  Capabilities,
  Change,
  Draft,
  EffectType,
  HostState,
  Permission,
  PluginAction,
  PluginHook,
  RuntimeCapabilities,
} from '@murmo/api';
import {
  type ExecutorFault,
  type ExecutorFaultCode,
  type InlineRules,
  type PluginDescriptor,
  routesFor,
} from '@murmo/api/adapter';
import type { ValidatedClaim } from './claims.ts';
import type { Ticket } from './stale.ts';

/** A loaded plugin as the session orders and gates it. */
export interface LoadedPlugin {
  readonly descriptor: PluginDescriptor;
  /** Set by the host for its own plugins only; third-party plugins get attributed edits and labels. */
  readonly builtin: boolean;
  /** The plugin failed to load; the session keeps it, disabled, so health shows it. */
  readonly loadError?: string;
  /** Built-in inline rule sets; registered in phase 07. Absent on third-party specs. */
  readonly inline?: readonly InlineRules[];
  readonly assets?: Readonly<Record<string, ArrayBuffer>>;
}

/** A plugin as the session tracks it, in plugin order. */
export interface PluginEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly builtin: boolean;
  /** A guard blocks the send whenever it fails, times out or lacks its permission. */
  readonly guard: boolean;
  /** Declared permissions; phase 09 substitutes grants. */
  readonly permissions: readonly Permission[];
  /** Hooks the plugin implements and its permissions open (`routesFor`; phase 09 uses grants). */
  readonly hooks: ReadonlySet<PluginHook>;
  /** Effect types its permissions open. */
  readonly effects: ReadonlySet<EffectType>;
  /** Logical actions the plugin declared (`murmo.menu`). */
  readonly actions: ReadonlySet<PluginAction>;
  /** Claims that survived load validation. Filled by the session before activation. */
  claims: readonly ValidatedClaim[];
  activated: boolean;
  disabled: boolean;
  reason?: string;
}

/** Phase 05 gates hooks and effects by the declared permissions, as the prototype did; phase 09 by grants. */
export function entryOf(plugin: LoadedPlugin): PluginEntry {
  const { descriptor } = plugin;
  const routes = routesFor(descriptor.permissions);
  return {
    id: descriptor.id,
    name: descriptor.name,
    version: descriptor.version,
    builtin: plugin.builtin,
    guard: descriptor.guard,
    permissions: descriptor.permissions,
    hooks: new Set(descriptor.hooks.filter((hook) => routes.hooks.includes(hook))),
    effects: new Set(routes.effects),
    actions: new Set(descriptor.actions),
    claims: [],
    activated: false,
    disabled: plugin.loadError !== undefined,
    ...(plugin.loadError === undefined ? {} : { reason: `load failed: ${plugin.loadError}` }),
  };
}

/** What the session knew when it asked for the call; the runner builds the plugin context from it. */
export interface HookSnapshot {
  readonly host: { readonly name: string; readonly version: string; readonly caps: Capabilities };
  readonly draft: Draft;
  readonly state: HostState;
  /** The change behind an `onChange` call. */
  readonly change?: Change;
}

export interface HookCall {
  readonly pluginId: string;
  readonly hook: PluginHook;
  /** The hook's argument (the change, the key, the menu item...). */
  readonly input: unknown;
  readonly ticket: Ticket;
  /** Cancelled once the result can no longer apply; the runner checks it before starting and after awaiting. */
  readonly signal: Cancellation;
  readonly snapshot: HookSnapshot;
}

export type RunnerHealth = 'ok' | 'degraded' | 'down';

export interface HookRunner {
  readonly runtime: RuntimeCapabilities;
  /** Spec IDs in the host's explicit list, before `load` (duplicate check happens here). */
  ids(): readonly string[];
  /** Loads every plugin, in the session's order. */
  load(): Promise<readonly LoadedPlugin[]>;
  /** Runs one hook; rejects with an `ExecutorFault`-shaped error. */
  run(call: HookCall): Promise<unknown>;
  unload(pluginId: string): Promise<void>;
  /** Reported apart from `ready`, so a dead executor never looks healthy (lessons 71, 76). */
  health(): RunnerHealth;
  dispose(): Promise<void>;
}

const faultCodes: ReadonlySet<string> = new Set<ExecutorFaultCode>([
  'cpu',
  'timeout',
  'memory',
  'cancelled',
  'exception',
  'output-limit',
  'transport',
]);

/** A rejection from `run`, as the session classifies it; anything untyped is an `exception`. */
export function faultOf(error: unknown, pluginId: string, hook: PluginHook): ExecutorFault {
  const e = error as { code?: unknown; message?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : String(error);
  const code = typeof e?.code === 'string' && faultCodes.has(e.code) ? (e.code as ExecutorFaultCode) : 'exception';
  return { code, pluginId, hook, message };
}

/**
 * What a fault does to the plugin. Phase 05's rule is the prototype's for
 * untyped exceptions: `cancelled` is no fault, anything else disables the
 * plugin at once. Phase 09 adds strikes for budget faults.
 */
export function disablesPlugin(fault: ExecutorFault): boolean {
  return fault.code !== 'cancelled';
}

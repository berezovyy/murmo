// The seam between the session and plugin code. The session never calls a
// plugin itself: it asks a HookRunner to run one hook and gets the raw result
// back. Phase 05 ships a direct runner for tests (`@murmo/core/testing`);
// phase 09 replaces it with the real executors, which add deadlines,
// permissions and grants, brokers and typed fault strikes.

import type {
  Cancellation,
  Capabilities,
  CapabilityRequirement,
  Change,
  Clock,
  Draft,
  EffectType,
  HostState,
  Negotiation,
  Permission,
  PluginAction,
  PluginHook,
  RuntimeCapabilities,
} from '@murmo/api';
import {
  type ExecutorFault,
  type ExecutorFaultCode,
  type HostCapabilities,
  type InlineRules,
  type PluginDescriptor,
  routesFor,
} from '@murmo/api/adapter';
import { codeOf } from '@murmo/executor';
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
  /** Held permissions after defaults and the host grant map (phase 09). */
  readonly granted?: readonly Permission[];
  readonly negotiation?: Negotiation;
  /** Host-marked required guard; a failed load still blocks send (phase 25). */
  readonly requiredGuard?: boolean;
  /** Manifest required capabilities, kept on load failure so coverage can still refuse. */
  readonly requiredCapabilities?: Readonly<Record<string, CapabilityRequirement>>;
  /** Optional capabilities this host does not meet. */
  readonly missingOptional?: readonly string[];
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
  /** Consecutive budget strikes per hook. */
  strikes: Record<string, number>;
  loaded: boolean;
  deniedEdits: number;
}

/** Gates hooks and effects by granted permissions (declared if the loader did not substitute). */
export function entryOf(plugin: LoadedPlugin): PluginEntry {
  const { descriptor } = plugin;
  const granted = plugin.granted ?? descriptor.permissions;
  const routes = routesFor(granted);
  return {
    id: descriptor.id,
    name: descriptor.name,
    version: descriptor.version,
    builtin: plugin.builtin,
    guard: descriptor.guard,
    permissions: granted,
    hooks: new Set(descriptor.hooks.filter((hook) => routes.hooks.includes(hook))),
    effects: new Set(routes.effects),
    actions: new Set(descriptor.actions),
    claims: [],
    activated: false,
    disabled: plugin.loadError !== undefined,
    strikes: {},
    loaded: plugin.loadError === undefined,
    deniedEdits: 0,
    ...(plugin.loadError === undefined ? {} : { reason: `load failed: ${plugin.loadError}` }),
  };
}

/** What the session knew when it asked for the call; the runner builds the plugin context from it. */
export interface HookSnapshot {
  readonly host: { readonly name: string; readonly version: string; readonly caps: Capabilities };
  readonly draft: Draft;
  readonly state: HostState;
  /** The change behind an `onChange` or `onPause` call. */
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
  /** Wall-clock budget for this call, before pressure scaling. Submit passes remaining time. */
  readonly timeoutMs?: number;
}

export type RunnerHealth = 'ok' | 'degraded' | 'down';

export interface HookRunner {
  readonly runtime: RuntimeCapabilities;
  /**
   * The clock plugins see as `ctx.clock`. A session given no clock of its own
   * times everything on it: the typing pause, submit deadlines, the commit
   * window and the third-party edit rate.
   */
  readonly clock: Clock;
  /** Spec IDs in the host's explicit list, before `load` (duplicate check happens here). */
  ids(): readonly string[];
  /** Loads every plugin, in the session's order. Caps are for manifest negotiation. */
  load(caps?: Capabilities | HostCapabilities): Promise<readonly LoadedPlugin[]>;
  /** Runs one hook; rejects with an `ExecutorFault`-shaped error. */
  run(call: HookCall): Promise<unknown>;
  unload(pluginId: string): Promise<void>;
  /** Reported apart from `ready`, so a dead executor never looks healthy (lessons 71, 76). */
  health(): RunnerHealth;
  dispose(): Promise<void>;
}

/** A rejection from `run`, as the session classifies it; untyped errors keep no code. */
export function faultOf(error: unknown, pluginId: string, hook: PluginHook): ExecutorFault {
  const message = error instanceof Error ? error.message : String(error);
  const code: ExecutorFaultCode = codeOf(error) ?? 'exception';
  const generation = (error as { generation?: unknown } | null)?.generation;
  return {
    code,
    pluginId,
    hook,
    message,
    ...(typeof generation === 'number' ? { generation } : {}),
  };
}

/**
 * Immediate disable? Budget faults strike instead; cancelled and untyped do not
 * disable; transport degrades the executor (phase 09).
 */
export function disablesPlugin(fault: ExecutorFault): boolean {
  return fault.code === 'memory' || fault.code === 'exception' || fault.code === 'output-limit';
}

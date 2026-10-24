// HookRunner in front of an Executor: unique IDs before any load, manifest
// preflight, `builtin` from the host spec only, grants, projection, brokers,
// coalesced `onChange`, and the routes the executor actually carries.

import type {
  Capabilities,
  GitAccess,
  Negotiation,
  NetworkAccess,
  Permission,
  PluginContext,
  PluginFactory,
  PluginHook,
  PluginManifest,
  RuntimeCapabilities,
} from '@murmo/api';
import type {
  Executor,
  HostCapabilities,
  InlineRules,
  PluginDescriptor,
  PluginSpec,
  ProjectFiles,
  StorageBackend,
} from '@murmo/api/adapter';
import { DEADLINES, HOOKS, negotiate, resolveSettings, routesFor, SERVICES } from '@murmo/api/adapter';
import { executorFault } from '@murmo/executor';
import { denyGit } from '../brokers/git.ts';
import { denyList, type ProjectListAccess } from '../brokers/list.ts';
import { denyNetwork } from '../brokers/network.ts';
import { createStorageBroker, type PluginStorageBroker } from '../brokers/storage.ts';
import type { HookCall, HookRunner, LoadedPlugin, RunnerHealth } from '../hooks.ts';
import { uniquePluginIds } from '../order.ts';
import { type AdmissionLimits, admit } from './admission.ts';
import { ChangeCoalescer } from './coalesce.ts';
import { type GrantMap, grantedPermissions } from './permissions.ts';
import { projectChange, projectDraft } from './projection.ts';

const hookNames = Object.keys(HOOKS) as PluginHook[];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const retryable = new Set(['cpu', 'timeout', 'transport']);

export interface HostPluginSpec {
  readonly id: string;
  readonly builtin: boolean;
  readonly factory?: PluginFactory;
  readonly source?: string;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly manifest?: PluginManifest;
  readonly requiredGuard?: boolean;
  readonly resources?: { readonly memoryMiB: number };
  readonly assets?: Readonly<Record<string, ArrayBuffer>>;
  /** Built-in inline rule sets (phase 07). Refused on third-party specs at registration. */
  readonly inline?: readonly InlineRules[];
}

export interface PluginHostOptions {
  readonly specs: readonly HostPluginSpec[];
  readonly executor: Executor;
  readonly grants?: GrantMap;
  readonly storage?: StorageBackend;
  /**
   * The store's durable per-plugin namespaces (`store.plugins`), where
   * `murmo plugin` snapshots and migrates them. Replaces `storage`.
   */
  readonly broker?: PluginStorageBroker;
  readonly projectFiles?: ProjectFiles;
  readonly list?: ProjectListAccess;
  readonly network?: NetworkAccess;
  readonly git?: GitAccess;
  readonly sessionId?: string;
  readonly admission?: AdmissionLimits;
  /** Override reported health (lesson 76: a dead executor must not look healthy). */
  readonly health?: RunnerHealth;
}

interface Loaded {
  readonly spec: HostPluginSpec;
  readonly descriptor: PluginDescriptor;
  readonly granted: readonly Permission[];
  readonly settings: Readonly<Record<string, unknown>>;
  readonly negotiation?: Negotiation;
  /** Where the executor runs it: its `runtime.executor`. */
  readonly placed: RuntimeCapabilities['executor'];
}

/** Capabilities as one plugin sees them: `runtime.executor` is where it runs. */
function placedCaps<T extends Capabilities | HostCapabilities>(caps: T, placed: RuntimeCapabilities['executor']): T {
  const runtime = (caps as Partial<Capabilities>).runtime;
  return runtime && runtime.executor !== placed ? { ...caps, runtime: { ...runtime, executor: placed } } : caps;
}

function asPluginSpec(spec: HostPluginSpec): PluginSpec {
  const base = {
    id: spec.id,
    ...(spec.factory ? { factory: spec.factory } : {}),
    ...(spec.source ? { source: spec.source } : {}),
    ...(spec.settings ? { settings: spec.settings } : {}),
    ...(spec.assets ? { assets: spec.assets } : {}),
    ...(spec.requiredGuard === undefined ? {} : { requiredGuard: spec.requiredGuard }),
    ...(spec.resources ? { resources: spec.resources } : {}),
    ...(spec.manifest ? { manifest: spec.manifest } : {}),
  };
  return spec.builtin
    ? { ...base, builtin: true as const, sandbox: false }
    : { ...base, builtin: false as const, manifest: spec.manifest as PluginManifest, sandbox: true };
}

function emptyDescriptor(spec: HostPluginSpec): PluginDescriptor {
  return {
    id: spec.id,
    name: spec.id,
    version: 'unknown',
    permissions: [],
    guard: spec.requiredGuard === true,
    keys: [],
    actions: [],
    hooks: [],
  };
}

function metadataMatches(spec: HostPluginSpec, descriptor: PluginDescriptor): boolean {
  const manifest = spec.manifest;
  if (!manifest) return true;
  if (descriptor.name !== manifest.name || descriptor.version !== manifest.version) return false;
  const declared = new Set(manifest.permissions.map((entry) => entry.name));
  return descriptor.permissions.every((permission) => declared.has(permission));
}

export interface PluginHost extends HookRunner {
  readonly executor: Executor;
  storage(): Readonly<Record<string, string>>;
  grantOf(pluginId: string): readonly Permission[];
  /**
   * Load one extra spec without touching plugins already in memory (E5).
   * `grants` replaces the grants this plugin was given, as `murmo plugin
   * grant` and `revoke-grant` change them.
   */
  loadOne(
    spec: HostPluginSpec,
    caps?: Capabilities | HostCapabilities,
    grants?: readonly Permission[],
  ): Promise<LoadedPlugin>;
}

export function createPluginHost(options: PluginHostOptions): PluginHost {
  const grants: Record<string, readonly Permission[]> = { ...options.grants };
  const local = options.broker ? undefined : createStorageBroker(options.storage);
  const storage: PluginStorageBroker = options.broker ?? (local as PluginStorageBroker);
  const coalescer = new ChangeCoalescer();
  const loaded = new Map<string, Loaded>();
  const specs = [...options.specs];
  let disposed = false;
  let health: RunnerHealth = 'ok';
  const services: RuntimeCapabilities['services'] = SERVICES.filter((service) => {
    if (service === 'project.read') return Boolean(options.projectFiles);
    if (service === 'project.list') return Boolean(options.list);
    if (service === 'network.request') return Boolean(options.network);
    if (service === 'git.query') return Boolean(options.git);
    return true;
  });

  const runtime: RuntimeCapabilities = {
    executor: options.executor.kind,
    hooks: hookNames,
    services,
  };

  const sessionId = options.sessionId ?? 'session';
  const networkBroker = options.network ?? denyNetwork();
  const gitBroker = options.git ?? denyGit();
  const listBroker = options.list ?? denyList();

  const context = (call: HookCall, entry: Loaded): PluginContext => {
    const evidence = call.snapshot.host.caps.inputOriginEvidence;
    const draft = projectDraft(call.snapshot.draft, entry.granted, evidence);
    const project = options.projectFiles;
    const allowed = entry.granted.includes('fs:project-read');
    const canList = entry.granted.includes('project:list');
    const canNet = entry.granted.includes('network');
    const canGit = entry.granted.includes('project:git');
    const host = clone(call.snapshot.host) as PluginContext['host'];
    return {
      ...(entry.negotiation ? { negotiation: clone(entry.negotiation) } : {}),
      host: { ...host, caps: placedCaps(host.caps, entry.placed) },
      draft,
      state: clone(call.snapshot.state),
      ...(call.snapshot.change ? { change: projectChange(call.snapshot.change, entry.granted, evidence) } : {}),
      settings: clone(entry.settings),
      signal: call.signal,
      clock: options.executor.clock,
      storage: storage.forPlugin(entry.spec.id),
      project: {
        read: async (path) => {
          if (!allowed || !project) {
            return { status: 'denied', reason: 'fs:project-read must be declared, granted and brokered' };
          }
          return project.read(entry.spec.id, path, call.signal);
        },
        list: async (query) => {
          if (!canList) return { status: 'denied', reason: 'project:list must be declared, granted and brokered' };
          return listBroker.list(entry.spec.id, query);
        },
      },
      network: {
        request: async (spec) => {
          if (!canNet) return { status: 'denied', reason: 'network must be declared, granted and brokered' };
          return networkBroker.request(spec);
        },
      },
      git: {
        query: async (spec) => {
          if (!canGit) return { status: 'denied', reason: 'project:git must be declared, granted and brokered' };
          return gitBroker.query(spec);
        },
      },
      session: { id: sessionId },
    };
  };

  const inputOf = (call: HookCall, ctx: PluginContext): unknown => {
    if (call.hook === 'onChange' || call.hook === 'onPause') return ctx.change;
    return clone(call.input);
  };

  const deadlineMs = (call: HookCall): number => {
    if (call.timeoutMs !== undefined) return call.timeoutMs;
    return DEADLINES[HOOKS[call.hook].deadline];
  };

  const execute = async (call: HookCall): Promise<unknown> => {
    if (disposed) throw executorFault('cancelled', 'cancelled');
    const entry = loaded.get(call.pluginId);
    if (!entry) throw executorFault('exception', `plugin ${call.pluginId} is not loaded`);
    const ctx = context(call, entry);
    try {
      const result = await options.executor.run(call.pluginId, call.hook, inputOf(call, ctx), ctx, {
        timeoutMs: deadlineMs(call),
        signal: call.signal,
      });
      // The key that dispatched this hook also updates the draft, which would
      // make the ticket stale. Drop the result, but never a typed guest fault
      // (C12: a looper must still be struck).
      if (call.signal.cancelled) throw executorFault('cancelled', 'cancelled');
      return result;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && code !== 'cancelled') throw error;
      if (call.signal.cancelled) throw executorFault('cancelled', 'cancelled');
      throw error;
    }
  };

  const loadOneSpec = async (spec: HostPluginSpec, caps?: Capabilities | HostCapabilities): Promise<LoadedPlugin> => {
    const fail = (error: unknown): LoadedPlugin => ({
      descriptor: emptyDescriptor(spec),
      builtin: spec.builtin,
      loadError: error instanceof Error ? error.message : String(error),
      granted: [],
      ...(spec.requiredGuard === true ? { requiredGuard: true as const } : {}),
      ...(spec.manifest?.capabilities.required ? { requiredCapabilities: spec.manifest.capabilities.required } : {}),
    });
    try {
      const placed = options.executor.kindOf?.(asPluginSpec(spec)) ?? options.executor.kind;
      let negotiation: Negotiation | undefined;
      let settings: Readonly<Record<string, unknown>> = spec.settings ?? {};
      if (spec.manifest) {
        if (caps) negotiation = negotiate(spec.manifest, placedCaps(caps, placed) as Capabilities);
        settings = resolveSettings(spec.manifest, spec.settings);
      }
      // An enabled inline rule set turns the async typo path off (docs/plan/07).
      if (spec.inline?.some((rule) => rule.enabled)) {
        settings = { ...settings, autocorrect: false };
      }
      const resources = spec.resources ?? spec.manifest?.resources;
      const pluginSpec = asPluginSpec({ ...spec, settings, ...(resources ? { resources } : {}) });
      admit(pluginSpec, options.admission);
      let descriptor: PluginDescriptor | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          descriptor = await options.executor.load(pluginSpec);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          const code = (error as { code?: unknown } | null)?.code;
          if (attempt === 0 && typeof code === 'string' && retryable.has(code)) continue;
          throw error;
        }
      }
      if (!descriptor) throw lastError;
      if (!metadataMatches(spec, descriptor)) {
        await options.executor.unload(spec.id);
        throw new Error('manifest metadata or permissions do not match plugin descriptor');
      }
      const granted = grantedPermissions(
        { id: spec.id, builtin: spec.builtin, declared: descriptor.permissions },
        grants,
      );
      const routes = routesFor(granted);
      if (routes.services.includes('project.read') && !services.includes('project.read')) {
        await options.executor.unload(spec.id);
        throw new Error('plugin requires project.read but the executor does not route it');
      }
      loaded.set(spec.id, {
        spec,
        descriptor,
        granted,
        settings,
        ...(negotiation ? { negotiation } : {}),
        placed,
      });
      return {
        descriptor: { ...descriptor, guard: descriptor.guard || spec.requiredGuard === true },
        builtin: spec.builtin,
        granted,
        ...(spec.requiredGuard === true ? { requiredGuard: true as const } : {}),
        ...(spec.manifest?.capabilities.required ? { requiredCapabilities: spec.manifest.capabilities.required } : {}),
        ...(negotiation ? { negotiation, missingOptional: negotiation.missingOptional } : {}),
        ...(spec.inline ? { inline: spec.inline } : {}),
        ...(spec.assets ? { assets: spec.assets } : {}),
      };
    } catch (error) {
      return fail(error);
    }
  };

  return {
    executor: options.executor,
    runtime,
    clock: options.executor.clock,

    ids(): readonly string[] {
      return specs.map((spec) => spec.id);
    },

    async loadOne(
      spec: HostPluginSpec,
      caps?: Capabilities | HostCapabilities,
      granted?: readonly Permission[],
    ): Promise<LoadedPlugin> {
      if (disposed) throw new Error('disposed');
      if (granted) grants[spec.id] = granted;
      if (loaded.has(spec.id)) await this.unload(spec.id);
      if (!specs.some((item) => item.id === spec.id)) specs.push(spec);
      else {
        const at = specs.findIndex((item) => item.id === spec.id);
        specs[at] = spec;
      }
      uniquePluginIds(specs.map((item) => item.id));
      return loadOneSpec(spec, caps);
    },

    async load(caps?: Capabilities | HostCapabilities): Promise<readonly LoadedPlugin[]> {
      uniquePluginIds(specs.map((spec) => spec.id));
      const out: LoadedPlugin[] = [];
      for (const spec of specs) out.push(await loadOneSpec(spec, caps));
      return out;
    },

    run(call: HookCall): Promise<unknown> {
      return coalescer.run(call, execute);
    },

    async unload(pluginId: string): Promise<void> {
      loaded.delete(pluginId);
      await options.executor.unload(pluginId);
    },

    health(): RunnerHealth {
      if (options.health) return options.health;
      if (disposed) return 'down';
      const stats = options.executor.stats() as { down?: boolean } | undefined;
      if (stats?.down === true) return 'down';
      return health;
    },

    async dispose(): Promise<void> {
      disposed = true;
      health = 'down';
      for (const id of [...loaded.keys()]) await this.unload(id);
      await options.executor.dispose();
      await options.projectFiles?.dispose();
    },

    storage(): Readonly<Record<string, string>> {
      return local?.snapshot() ?? {};
    },

    grantOf(pluginId: string): readonly Permission[] {
      return loaded.get(pluginId)?.granted ?? [];
    },
  };
}

export function deadlineFor(hook: PluginHook): number {
  return DEADLINES[HOOKS[hook].deadline];
}

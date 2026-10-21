// One Murmo session on one host draft: lifecycle, wiring and stats. The
// session takes the adapter's draft and change events (draft-state.ts), keeps
// versions and the key epoch, runs plugin hooks through a HookRunner, applies
// their effects only while they are still current (stale.ts, effects.ts),
// commits edits through the adapter's compare-and-set (edits.ts), owns the
// undo of its own edits (undo.ts), shows ghost, highlight and status
// (present.ts), and never throws into the host (guard.ts).
//
// Where later phases extend it: the key path is the router in keys.ts
// (native → undo → menu → claims); the inline evaluator is 07; commit gates
// add permissions, edit rate and attribution (09); the runner becomes the
// real executors (09).
//
// Phase 08: `onBeforeSubmit` / `onSubmitCommitted` subscriptions, the submit
// window gate, and `finalGuard`.

import type {
  ActionId,
  Capabilities,
  Change,
  Clock,
  Draft,
  Edit,
  KeyId,
  PluginHook,
  SubmitGesture,
  SubmitTransaction,
} from '@murmo/api';
import type { Adapter, HostCapabilities, MenuSelection, SubmitOutcome, Unsubscribe } from '@murmo/api/adapter';
import { validateClaims } from './claims.ts';
import { type Accepted, DraftState } from './draft-state.ts';
import { type CommitGate, Edits, editable } from './edits.ts';
import { applyEffects, type EffectDeps } from './effects.ts';
import { FAILURE_LIMIT, FailOpen } from './guard.ts';
import {
  disablesPlugin,
  entryOf,
  faultOf,
  type HookCall,
  type HookRunner,
  type HookSnapshot,
  type PluginEntry,
} from './hooks.ts';
import { KeyRouter } from './keys.ts';
import { Menu } from './menu.ts';
import { resolveOrder } from './order.ts';
import { Presentation } from './present.ts';
import { isCurrent, issueTicket, type SessionView, type Ticket } from './stale.ts';
import { Counters, type SessionStats } from './stats.ts';
import { type MenuSurface, SubmitController, submitOptions } from './submit/index.ts';
import { UndoLog } from './undo.ts';

export interface SessionOptions {
  readonly adapter: Adapter;
  readonly runner: HookRunner;
  /** Shown once if the session turns itself off; the host decides how (Pi `ui.notify`, a status row...). */
  readonly notify?: (message: string) => void;
  /**
   * The adapter reports a multi-code-point `typed` delta only for a burst of
   * individual keys (Pi, OpenCode, the Codex wrapper, the reference adapter).
   * Default false: such a delta adds no typed coverage (lesson 64).
   */
  readonly keyBursts?: boolean;
  /** Core errors in one session before it turns itself off. */
  readonly failureLimit?: number;
  /**
   * Extra checks at step 5 of the commit path. The submit window
   * (`submit-in-progress`) is always installed; phase 09 adds permissions,
   * edit rate and attribution.
   */
  readonly gates?: readonly CommitGate[];
  /**
   * Configured plugin order (every spec ID once). When omitted, the runner's
   * spec list is the order. Missing, duplicate or unknown IDs refuse loading.
   */
  readonly order?: readonly string[];
  /** Injected time: submit deadlines and the commit window. */
  readonly clock?: Clock;
  /** `final-boundary` refuses a managed-position call (V1-require-final). Default `managed`. */
  readonly guardPolicy?: 'managed' | 'final-boundary';
  /** Off until phase 29 measures host submit-hook limits (lesson 76). */
  readonly scaleSubmitDeadline?: boolean;
  readonly pressure?: number;
  /** Forward until clear, default 2_000 ms. */
  readonly commitWindowMs?: number;
  /** Test override; the session's merged menu is the default. */
  readonly menu?: MenuSurface;
}

export interface Session {
  /** Probes the host, publishes capabilities, loads plugins, subscribes, activates. */
  readonly ready: Promise<void>;
  /** The measured capabilities plus the runner's routes, once `ready` resolved. */
  caps(): Capabilities | undefined;
  /** The session's draft: the adapter's text with the typed spans the core verified. */
  draft(): Draft | undefined;
  /** Resolves once every task started so far, and every task those started, has finished. */
  settle(): Promise<void>;
  /** Tasks in flight and tasks finished so far; a driver with a manual clock settles on these. */
  activity(): { readonly pending: number; readonly settled: number };
  /** Unsubscribes, cancels everything in flight, hides Murmo's UI, unloads plugins. */
  dispose(): Promise<void>;
  stats(): SessionStats;
  /** The adapter's `onBeforeSubmit` callback; also callable from tests. */
  beforeSubmit(tx: SubmitTransaction): Promise<SubmitOutcome>;
  /** Guards-only pass at the host's final boundary (Claude `UserPromptSubmit`). */
  finalGuard(input: { text: string; gesture: SubmitGesture }): Promise<SubmitOutcome>;
}

export const KILL_NOTICE = 'Murmo turned itself off after repeated errors in this session';

const noop = (): void => {};

export function createSession(options: SessionOptions): Session {
  return new CoreSession(options);
}

class CoreSession implements Session {
  readonly ready: Promise<void>;
  readonly #adapter: Adapter;
  readonly #runner: HookRunner;
  readonly #options: SessionOptions;
  readonly #counters = new Counters();
  readonly #guard: FailOpen;
  readonly #undo = new UndoLog();
  readonly #tasks = new Set<Promise<void>>();
  readonly #unsubscribe: Unsubscribe[] = [];
  readonly #latest = new Map<string, number>();
  #plugins: PluginEntry[] = [];
  #byId = new Map<string, PluginEntry>();
  #hostCaps: HostCapabilities | undefined;
  #caps: Capabilities | undefined;
  #intake: DraftState | undefined;
  #presentation: Presentation | undefined;
  #menu: Menu | undefined;
  #router: KeyRouter | undefined;
  #edits: Edits | undefined;
  #effects: EffectDeps | undefined;
  #view: SessionView | undefined;
  /** Phase 08. */
  #submit: SubmitController | undefined;
  #queue: Promise<void> = Promise.resolve();
  #seq = 0;
  #settled = 0;
  #subscribed = false;
  #disposed = false;
  #disposing: Promise<void> | undefined;
  #killNotice: string | undefined;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#adapter = options.adapter;
    this.#runner = options.runner;
    this.#guard = new FailOpen(() => this.#kill(), options.failureLimit ?? FAILURE_LIMIT);
    this.ready = this.#start();
  }

  caps(): Capabilities | undefined {
    return this.#caps;
  }

  draft(): Draft | undefined {
    return this.#intake?.draft;
  }

  activity(): { pending: number; settled: number } {
    return { pending: this.#tasks.size, settled: this.#settled };
  }

  get #live(): boolean {
    return this.#subscribed && !this.#disposed;
  }

  async #start(): Promise<void> {
    const adapter = this.#adapter;
    const hostCaps = await adapter.ready();
    if (this.#disposed) return;
    this.#hostCaps = hostCaps;
    this.#caps = { ...hostCaps, runtime: this.#runner.runtime };
    // Duplicate / missing / unknown IDs refuse before any executor load (r14 K1).
    const orderedIds = resolveOrder(this.#runner.ids(), this.#options.order);
    const loaded = await this.#runner.load();
    if (this.#disposed) return;
    const loadedById = new Map(loaded.map((p) => [p.descriptor.id, p]));
    this.#plugins = orderedIds.map((id) => {
      const plugin = loadedById.get(id);
      if (!plugin) throw new Error(`unknown ordered plugin ${id}`);
      return entryOf(plugin);
    });
    this.#byId = new Map(this.#plugins.map((p) => [p.id, p]));

    const intake = new DraftState(adapter.getDraft(), {
      evidence: hostCaps.inputOriginEvidence,
      keyBursts: this.#options.keyBursts ?? false,
    });
    this.#intake = intake;
    const view = this.#makeView(intake);
    this.#view = view;
    const counters = this.#counters;
    const isEditable = () => editable(adapter.getState(), intake.draft);
    const presentation = new Presentation({
      adapter,
      caps: hostCaps,
      plugins: () => this.#plugins.filter((p) => !p.disabled),
      draft: () => intake.draft,
      state: () => adapter.getState(),
      editable: isEditable,
      counters,
    });
    this.#presentation = presentation;
    const notice = (text: string) => presentation.notice(text);
    const menu = new Menu({
      adapter,
      caps: hostCaps,
      plugins: () => this.#plugins.filter((p) => !p.disabled),
      draft: () => intake.draft,
      popup: () => adapter.getState().popup !== null,
      editable: isEditable,
      counters,
    });
    this.#menu = menu;
    const submitOpts = submitOptions(this.#options);
    // Phase 08: submit window is a live commit-path gate (r14 S1 last-moment).
    const submit = new SubmitController({
      host: () => ({
        name: adapter.host.name,
        version: adapter.host.version,
        caps: this.#caps ?? { ...hostCaps, runtime: this.#runner.runtime },
      }),
      adapterCaps: () => this.#hostCaps ?? hostCaps,
      view,
      runner: this.#runner,
      clock: submitOpts.clock,
      plugins: () => this.#plugins,
      counters,
      notice,
      menu: this.#options.menu ?? menu,
      guardPolicy: submitOpts.guardPolicy,
      evidence: hostCaps.inputOriginEvidence,
      deadlineMs: submitOpts.deadlineMs,
      commitWindowMs: submitOpts.commitWindowMs,
      fault: (plugin, hook, error) => this.#fault(plugin, hook, error),
      onLifecycleReset: () => this.#resetOnCommit(),
      track: (work) => this.#track(work),
      seq: () => ++this.#seq,
      setLatest: (id, hook, seq) => this.#latest.set(`${id}\u0000${hook}`, seq),
      applyEffects: (plugin, value, ticket: Ticket) => {
        const effects = this.#effects;
        return effects ? applyEffects(plugin, value, ticket, effects) : Promise.resolve();
      },
    });
    this.#submit = submit;
    const edits = new Edits({
      adapter,
      caps: hostCaps,
      view,
      intake,
      undo: this.#undo,
      counters,
      gates: [submit, ...(this.#options.gates ?? [])],
      notice,
      publish: (accepted) => this.#publish(accepted),
    });
    this.#edits = edits;
    this.#effects = { view, edits, presentation, menu, counters, editable: isEditable, notice };

    for (const plugin of this.#plugins) {
      const source = loadedById.get(plugin.id);
      if (!source) continue;
      const { claims, notices } = validateClaims(plugin, source.descriptor.keys, hostCaps);
      plugin.claims = claims;
      for (const text of notices) notice(text);
    }

    this.#router = new KeyRouter({
      live: () => this.#live,
      caps: () => hostCaps,
      draft: () => intake.draft,
      state: () => adapter.getState(),
      plugins: () => this.#plugins,
      undo: this.#undo,
      menu,
      ghost: () => presentation.visibleGhost,
      editable: isEditable,
      counters,
      bumpEpoch: () => intake.bumpEpoch(),
      restore: (record, gesture) => {
        const epoch = intake.epoch;
        this.#enqueue(() => this.#edits?.restore(record, gesture, epoch) ?? Promise.resolve());
      },
      acceptGhost: (plugin, text) => this.#acceptGhost(plugin, text),
      dispatch: (plugin, key) => this.#schedule(plugin, 'onKey', key),
      menuSelect: (plugin, item) => this.#schedule(plugin, 'onMenuSelect', item),
      render: () => {
        presentation.render();
        menu.render();
      },
    });

    const guard = this.#guard;
    this.#unsubscribe.push(
      adapter.onDraftChange(guard.wrap((change: Change) => this.#changed(change), undefined)),
      adapter.onKey(guard.wrap((key: KeyId) => this.#key(key), 'pass' as const)),
      adapter.onBeforeSubmit(async (tx) => this.beforeSubmit(tx)),
    );
    if (adapter.onAction) {
      this.#unsubscribe.push(adapter.onAction(guard.wrap((action: ActionId) => this.#action(action), undefined)));
    }
    if (adapter.onMenuSelect) {
      this.#unsubscribe.push(
        adapter.onMenuSelect(guard.wrap((selection: MenuSelection) => this.#semanticSelect(selection), undefined)),
      );
    }
    if (adapter.onSubmitCommitted) {
      this.#unsubscribe.push(
        adapter.onSubmitCommitted(guard.wrap((event) => this.#submit?.noteAccepted(event), undefined)),
      );
    }
    this.#subscribed = true;
    for (const plugin of this.#plugins) {
      if (plugin.hooks.has('activate')) this.#schedule(plugin, 'activate', null);
      else if (!plugin.disabled) plugin.activated = true;
    }
    presentation.render();
  }

  #makeView(intake: DraftState): SessionView {
    const session = this;
    return {
      get alive() {
        return session.#live;
      },
      get owner() {
        return session.#live;
      },
      get epoch() {
        return intake.epoch;
      },
      get draft() {
        return intake.draft;
      },
      state: () => this.#adapter.getState(),
      enabled: (id) => this.#byId.get(id)?.disabled === false,
      latestSeq: (id, hook) => this.#latest.get(`${id}\u0000${hook}`) ?? -1,
    };
  }

  // -------------------------------------------------------------------------
  // Adapter callbacks: synchronous, never awaited by the adapter, never throw.

  #changed(change: Change): void {
    if (!this.#live || !this.#intake) return;
    this.#publish(this.#intake.receive(change));
  }

  /**
   * The key path: one synchronous router (native UI, undo, menu, claims).
   * Phase 07 inserts inline evaluation beside this; phase 08 does not touch it.
   */
  #key(key: KeyId): 'consume' | 'pass' {
    this.#submit?.noteKey();
    return this.#router?.route(key).result ?? 'pass';
  }

  /** `accept-ghost`: insert exactly the displayed ghost as a versioned edit. */
  #acceptGhost(plugin: PluginEntry, text: string): void {
    const intake = this.#intake;
    const view = this.#view;
    const presentation = this.#presentation;
    const edits = this.#edits;
    if (!intake || !view || !presentation || !edits) return;
    const draft = intake.draft;
    presentation.setGhost(plugin, null, draft.version);
    this.#menu?.close();
    const edit: Edit = {
      from: draft.cursor,
      to: draft.cursor,
      insert: text,
      baseVersion: draft.version,
      undoable: true,
      label: 'ghost',
    };
    const seq = ++this.#seq;
    this.#latest.set(`${plugin.id}\u0000onKey`, seq);
    const ticket = issueTicket(plugin.id, 'onKey', seq, view);
    this.#enqueue(() => edits.commit(plugin, edit, ticket));
  }

  /** Logical actions (`murmo.undo`, `murmo.menu`); never faked as raw keys. */
  #action(action: ActionId): void {
    const intake = this.#intake;
    const caps = this.#hostCaps;
    if (!this.#live || !intake || !caps?.actions.includes(action)) return;
    const state = this.#adapter.getState();
    const draft = intake.draft;
    if (action === 'murmo.undo') {
      const record = this.#undo.armed(draft);
      if (!record || !caps.edit.exactRestore || !editable(state, draft)) return;
      intake.bumpEpoch();
      this.#undo.pop();
      const epoch = intake.epoch;
      this.#enqueue(() => this.#edits?.restore(record, 'undo-key', epoch) ?? Promise.resolve());
      return;
    }
    if (action === 'murmo.menu') {
      if (state.popup !== null || state.dialog || !editable(state, draft)) return;
      intake.bumpEpoch();
      for (const plugin of this.#plugins) {
        if (plugin.disabled || !plugin.actions.has('murmo.menu') || !plugin.hooks.has('onAction')) continue;
        this.#schedule(plugin, 'onAction', 'murmo.menu');
      }
    }
  }

  /** Native host menu selection `{pluginId, itemId, baseVersion}`. */
  #semanticSelect(selection: MenuSelection): void {
    const menu = this.#menu;
    const intake = this.#intake;
    if (!this.#live || !menu || !intake) return;
    const chosen = menu.find(selection);
    if (!chosen) return;
    intake.bumpEpoch();
    menu.close();
    this.#schedule(chosen.plugin, 'onMenuSelect', chosen.item);
  }

  // -------------------------------------------------------------------------
  // Changes, hooks and effects

  #publish(accepted: readonly Accepted[]): void {
    const intake = this.#intake;
    const presentation = this.#presentation;
    if (!intake || !presentation) return;
    for (const { change, own } of accepted) {
      this.#counters.changes++;
      if (own) this.#counters.ownChanges++;
      else intake.bumpEpoch();
      this.#undo.observe(change.draft);
      this.#submit?.noteChange(change.draft);
      presentation.dropStale(change.draft.version);
      this.#menu?.dropStale(change.draft.version);
      presentation.render();
      this.#menu?.render();
      for (const plugin of this.#plugins) this.#schedule(plugin, 'onChange', change, change);
    }
  }

  #schedule(plugin: PluginEntry, hook: PluginHook, input: unknown, change?: Change): void {
    const view = this.#view;
    const caps = this.#caps;
    const effects = this.#effects;
    if (!this.#live || !view || !caps || !effects || plugin.disabled || !plugin.hooks.has(hook)) return;
    const seq = ++this.#seq;
    this.#latest.set(`${plugin.id}\u0000${hook}`, seq);
    const ticket = issueTicket(plugin.id, hook, seq, view);
    const snapshot: HookSnapshot = {
      host: { name: this.#adapter.host.name, version: this.#adapter.host.version, caps },
      draft: view.draft,
      state: view.state(),
      ...(change ? { change } : {}),
    };
    const call: HookCall = {
      pluginId: plugin.id,
      hook,
      input,
      ticket,
      signal: {
        get cancelled() {
          return !isCurrent(ticket, view);
        },
      },
      snapshot,
    };
    this.#track(
      this.#runner.run(call).then(
        (value) => {
          if (hook === 'activate') plugin.activated = true;
          this.#enqueue(() => applyEffects(plugin, value, ticket, effects));
        },
        (error) => this.#fault(plugin, hook, error),
      ),
    );
  }

  #fault(plugin: PluginEntry, hook: PluginHook, error: unknown): void {
    const fault = faultOf(error, plugin.id, hook);
    if (fault.code === 'cancelled') return;
    this.#counters.faults++;
    if (disablesPlugin(fault)) this.#disable(plugin, `${hook} failed: ${fault.message}`);
  }

  #disable(plugin: PluginEntry, reason: string): void {
    if (plugin.disabled || this.#disposed) return;
    plugin.disabled = true;
    plugin.reason = reason;
    this.#presentation?.forget(plugin.id);
    this.#menu?.forget(plugin.id);
    this.#presentation?.notice(`${plugin.name} disabled: ${reason}`);
    this.#menu?.render();
    this.#track(this.#runner.unload(plugin.id));
  }

  /** Effects and restores run one at a time, in order, so two commits never interleave. */
  #enqueue(work: () => Promise<unknown>): void {
    const task = this.#track(this.#queue.then(work));
    this.#queue = task;
  }

  /** Tracks a task for `settle`; an error escaping one is a core failure for the guard. */
  #track(work: Promise<unknown>): Promise<void> {
    const task = work.then(noop, (error: unknown) => this.#guard.record(error));
    this.#tasks.add(task);
    void task.then(() => {
      this.#tasks.delete(task);
      this.#settled++;
    });
    return task;
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  async settle(): Promise<void> {
    await this.ready;
    while (this.#tasks.size) await Promise.allSettled([...this.#tasks]);
  }

  // Phase 08: adapter-facing submit. Fail closed on a core throw so a send a
  // guard would block cannot ride a pipeline crash (guards fail closed; E8).
  async beforeSubmit(tx: SubmitTransaction): Promise<SubmitOutcome> {
    await this.ready;
    const submit = this.#submit;
    if (!this.#live || !submit) return { action: 'block', reason: 'session is not ready' };
    try {
      return await submit.beforeSubmit(tx);
    } catch (error) {
      this.#guard.record(error);
      return { action: 'block', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async finalGuard(input: { text: string; gesture: SubmitGesture }): Promise<SubmitOutcome> {
    await this.ready;
    const submit = this.#submit;
    if (!this.#live || !submit) return { action: 'block', reason: 'session is not ready' };
    try {
      return await submit.finalGuard(input);
    } catch (error) {
      this.#guard.record(error);
      return { action: 'block', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Per-draft state that a committed send drops (pending `.` and rejected words are 07/13). */
  #resetOnCommit(): void {
    this.#undo.clear();
    this.#intake?.bumpEpoch();
    this.#options.menu?.dismiss();
    this.#menu?.dismiss();
  }

  #kill(): void {
    this.#killNotice = KILL_NOTICE;
    try {
      this.#options.notify?.(KILL_NOTICE);
    } catch {
      // The host's notice callback must not keep the session alive.
    }
    void this.dispose();
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#dispose();
    return this.#disposing;
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;
    this.#submit?.dispose();
    this.#intake?.bumpEpoch();
    for (const off of this.#unsubscribe.splice(0)) {
      try {
        off();
      } catch {
        // An adapter that fails to unsubscribe is still left alone from here on.
      }
    }
    while (this.#tasks.size) await Promise.allSettled([...this.#tasks]);
    this.#menu?.close();
    this.#presentation?.clearAll();
    try {
      await this.#runner.dispose();
    } catch {
      // Plugins are gone either way.
    }
  }

  stats(): SessionStats {
    const c = this.#counters;
    const commits = { ...c.commits };
    const notices = [...(this.#presentation?.notices ?? []), ...(this.#killNotice ? [this.#killNotice] : [])];
    return {
      ready: this.#subscribed,
      disposed: this.#disposed,
      killed: this.#killNotice !== undefined,
      executor: this.#runner.health(),
      plugins: this.#plugins.map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        builtin: p.builtin,
        activated: p.activated,
        disabled: p.disabled,
        ...(p.reason === undefined ? {} : { reason: p.reason }),
      })),
      disabled: this.#plugins.filter((p) => p.disabled).map((p) => p.id),
      notices,
      epoch: this.#intake?.epoch ?? 0,
      version: this.#intake?.draft.version ?? -1,
      undoDepth: this.#undo.depth,
      resyncs: this.#intake?.resyncs ?? 0,
      ledgerChecks: this.#intake?.ledgerChecks ?? 0,
      keys: c.keys,
      keyBy: { ...c.keyBy },
      changes: c.changes,
      ownChanges: c.ownChanges,
      stale: c.staleEffects + commits.stale + commits.cancelled,
      denied: c.deniedEffects + commits.denied,
      unsupported: c.unsupportedEffects + commits.unsupported,
      invalid: c.invalidEffects + commits['invalid-range'],
      applied: commits.applied,
      commits,
      restores: c.restores,
      restoreMismatches: c.restoreMismatches,
      ui: {
        ghost: { ...c.ui.ghost },
        highlight: { ...c.ui.highlight },
        status: { ...c.ui.status },
        menu: { ...c.ui.menu },
      },
      failures: this.#guard.failures,
      faults: c.faults,
      submits: c.submits,
      blocked: c.blocked,
      ...(c.lastBlockReason === undefined ? {} : { lastBlockReason: c.lastBlockReason }),
      committed: c.committed,
      unresolved: c.unresolved,
      observerOverflow: c.observerOverflow,
      ...(c.lastDeniedReason === undefined ? {} : { lastDeniedReason: c.lastDeniedReason }),
    };
  }
}

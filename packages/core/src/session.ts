// One Murmo session on one host draft: lifecycle, wiring and stats. The
// session takes the adapter's draft and change events (draft-state.ts), keeps
// versions and the key epoch, runs plugin hooks through a HookRunner, applies
// their effects only while they are still current (stale.ts, effects.ts),
// commits edits through the adapter's compare-and-set (edits.ts), owns the
// undo of its own edits (undo.ts), shows ghost, highlight and status
// (present.ts), and never throws into the host (guard.ts).
//
// Where later phases extend it: the key path (`#key`) gains the merged menu
// and key claims after the undo stage (06) and the inline evaluator (07);
// the session subscribes to `onBeforeSubmit` (08); commit gates add the submit
// window (08) and permissions, edit rate and attribution (09); the runner
// becomes the real executors (09).

import type { Capabilities, Change, Draft, KeyId, PluginHook } from '@murmo/api';
import type { Adapter, HostCapabilities, Unsubscribe } from '@murmo/api/adapter';
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
import { Presentation } from './present.ts';
import { isCurrent, issueTicket, type SessionView } from './stale.ts';
import { Counters, type SessionStats } from './stats.ts';
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
   * Extra checks at step 5 of the commit path. Phase 08 adds the submit
   * window (`submit-in-progress`), phase 09 permissions, edit rate and
   * attribution.
   */
  readonly gates?: readonly CommitGate[];
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
  #edits: Edits | undefined;
  #effects: EffectDeps | undefined;
  #view: SessionView | undefined;
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
    const loaded = await this.#runner.load();
    if (this.#disposed) return;
    const ids = new Set<string>();
    for (const plugin of loaded) {
      const id = plugin.descriptor.id;
      if (ids.has(id)) throw new Error(`duplicate plugin ID ${JSON.stringify(id)}: plugin identities must be unique`);
      ids.add(id);
    }
    this.#plugins = loaded.map(entryOf);
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
    const edits = new Edits({
      adapter,
      caps: hostCaps,
      view,
      intake,
      undo: this.#undo,
      counters,
      gates: this.#options.gates ?? [],
      notice,
      publish: (accepted) => this.#publish(accepted),
    });
    this.#edits = edits;
    this.#effects = { view, edits, presentation, counters, editable: isEditable, notice };

    const guard = this.#guard;
    this.#unsubscribe.push(
      adapter.onDraftChange(guard.wrap((change: Change) => this.#changed(change), undefined)),
      adapter.onKey(guard.wrap((key: KeyId) => this.#key(key), 'pass' as const)),
    );
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
   * The key path, in order: native UI first, then Murmo's own undo window.
   * Phase 06 adds the merged menu and the key claims after the undo stage.
   */
  #key(key: KeyId): 'consume' | 'pass' {
    const intake = this.#intake;
    const caps = this.#hostCaps;
    const presentation = this.#presentation;
    if (!this.#live || !intake || !caps || !presentation) return 'pass';
    this.#counters.keys++;
    intake.bumpEpoch();
    const state = this.#adapter.getState();
    // A host popup or dialog owns the key; the undo window closes.
    if (state.popup !== null || state.dialog) {
      this.#undo.clear();
      return 'pass';
    }
    const draft = intake.draft;
    const canEdit = editable(state, draft);
    if (!canEdit || !caps.keys.includes(key)) {
      this.#undo.clear();
      if (!canEdit) presentation.render();
      return 'pass';
    }
    const record = this.#undo.armed(draft);
    if (record && caps.edit.exactRestore && (key === 'Backspace' || caps.undoKeys.includes(key))) {
      this.#undo.pop();
      const epoch = intake.epoch;
      const gesture = key === 'Backspace' ? 'backspace' : 'undo-key';
      this.#enqueue(() => this.#edits?.restore(record, gesture, epoch) ?? Promise.resolve());
      return 'consume';
    }
    // Any other key hands undo back to the host.
    this.#undo.clear();
    return 'pass';
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
      presentation.dropStale(change.draft.version);
      presentation.render();
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
    this.#presentation?.notice(`${plugin.name} disabled: ${reason}`);
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
    this.#intake?.bumpEpoch();
    for (const off of this.#unsubscribe.splice(0)) {
      try {
        off();
      } catch {
        // An adapter that fails to unsubscribe is still left alone from here on.
      }
    }
    while (this.#tasks.size) await Promise.allSettled([...this.#tasks]);
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
      },
      failures: this.#guard.failures,
      faults: c.faults,
    };
  }
}

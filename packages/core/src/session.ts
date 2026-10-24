// One Murmo session on one host draft: lifecycle, wiring and stats. The
// session takes the adapter's draft and change events (draft-state.ts), keeps
// versions and the key epoch, runs plugin hooks through a HookRunner, applies
// their effects only while they are still current (stale.ts, effects.ts),
// commits edits through the adapter's compare-and-set (edits.ts), owns the
// undo of its own edits (undo.ts), shows ghost, highlight and status
// (present.ts), and never throws into the host (guard.ts).
//
// The key path is the router in keys.ts (native → undo → menu → claims) plus
// the inline evaluator (phase 07) on `onInlineEdit`.
//
// Phase 08: `onBeforeSubmit` / `onSubmitCommitted` subscriptions, the submit
// window gate, and `finalGuard`.
// Phase 09: executor-backed runner, permission/rate/attribution gates next
// to the submit window, typed fault strikes.
// Phase 32: review/cooldown for third-party edits; session.id; helper-down send block.

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
import { LIMITS } from '@murmo/api';
import type {
  Adapter,
  HostCapabilities,
  InlineAnswer,
  InlineCommit,
  InlineRejection,
  InlineSnapshot,
  MenuSelection,
  ReviewPanel,
  SubmitOutcome,
  Unsubscribe,
} from '@murmo/api/adapter';
import { validateClaims } from './claims.ts';
import { BoundaryBook, bookOf, inspectGuardCoverage, nativeUiOpen } from './coexistence.ts';
import { type Accepted, DraftState } from './draft-state.ts';
import { type CommitGate, Edits, editable } from './edits.ts';
import { applyEffects, type EffectDeps } from './effects.ts';
import { FieldSessions } from './fields.ts';
import { FAILURE_LIMIT, FailOpen } from './guard.ts';
import {
  entryOf,
  type HookCall,
  type HookRunner,
  type HookSnapshot,
  type LoadedPlugin,
  type PluginEntry,
  type RunnerHealth,
} from './hooks.ts';
import {
  createInlineStage,
  type InlineStage,
  type RegisteredInline,
  registerRuleSet,
  type ShortcutCounts,
} from './inline/index.ts';
import { KeyRouter } from './keys.ts';
import { Menu } from './menu.ts';
import { resolveOrder } from './order.ts';
import { FaultBook } from './plugins/faults.ts';
import { attributionGate, permissionGate, reviewCapabilityGate } from './plugins/gates.ts';
import { nameNotice } from './plugins/names.ts';
import { EditRate } from './plugins/rate.ts';
import { Presentation } from './present.ts';
import { ReviewLog, type ReviewMode } from './review.ts';
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
   * What the host has to say when the session starts (that Murmo is on, config
   * problems, project trust), most important first. They show once the session
   * is ready and leave the screen at the first send, like any other notice.
   */
  readonly notices?: readonly string[];
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
  /** Submit deadlines, the commit window and the edit rate; default the runner's clock. */
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
  /** Immediate Backspace/undo of a typo (phase 19 learning). */
  readonly onRejectedWord?: (word: string) => void;
  /**
   * Phase 32: `always` (default) stops send for every unreviewed third-party
   * edit; `flagged` only for zero-width, bidi, homoglyph or off-screen edits.
   */
  readonly reviewThirdPartyEdits?: ReviewMode;
  /** Phase 32: stable `ctx.session.id`. Generated when omitted. */
  readonly sessionId?: string;
}

export interface Session {
  /** Probes the host, publishes capabilities, loads plugins, subscribes, activates. */
  readonly ready: Promise<void>;
  /** Phase 32: stable across plugin reload in this session. */
  readonly sessionId: string;
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
  /**
   * Replace one built-in inline rule set between keys (phase 15 config reload).
   * An expansion already planned finishes against the table it started with.
   */
  replaceInline(rule: RegisteredInline): void;
  /**
   * Reload one plugin. Other plugins keep their in-memory state (E5). Key
   * handling never waits for this. A replaced built-in's inline rule sets
   * replace the old ones between keys, as `replaceInline` does.
   */
  applyPlugin(change: PluginChange): Promise<PluginActivation>;
  /**
   * The host's startup notices changed (its config was edited while the
   * session runs): those no longer true leave the screen, the new ones show.
   * Before `ready`, these are the notices the session starts with.
   */
  restateNotices(notices: readonly string[]): void;
}

export type PluginActivation = 'loaded' | 'activated' | 'disabled' | 'error';

export type PluginChange =
  | { readonly action: 'disable'; readonly id: string }
  | { readonly action: 'enable'; readonly id: string }
  | { readonly action: 'remove'; readonly id: string }
  | {
      readonly action: 'replace';
      readonly plugin: LoadedPlugin;
      /** Where a plugin the session doesn't run yet goes: before the first one after it here. Default last. */
      readonly order?: readonly string[];
    };

export const KILL_NOTICE = 'Murmo turned itself off after repeated errors in this session';

/**
 * The keys that put back what a fix or an expansion replaced, as the user
 * presses them: Backspace on every host, plus a host's own undo key where the
 * core restores on it (Pi's F6). The logical `Undo` has no single key to name,
 * and on Claude Ctrl+Z suspends the agent, so it is never offered.
 */
export function restoreKeys(caps: Pick<HostCapabilities, 'undoKeys' | 'edit'>): string {
  const extra = caps.edit.exactRestore ? caps.undoKeys.filter((key) => key !== 'Undo' && key !== 'Backspace') : [];
  return ['Backspace', ...extra].join(' or ');
}

/**
 * The first typo fix and the first shortcut expansion of a session say what
 * happened and how to take it back. "Right after" keeps the line true once
 * the cursor moves on and Backspace no longer restores.
 */
export function firstFixNotice(kind: 'typo' | 'expansion', caps: Pick<HostCapabilities, 'undoKeys' | 'edit'>): string {
  const what = kind === 'typo' ? 'Autocorrect fixed a typo' : 'Shortcut expanded';
  return `${what}. ${restoreKeys(caps)} right after undoes it.`;
}

/** The one notice a plugin the session turned off gets; `murmo doctor` has the details. */
export function disabledNotice(name: string, why: 'slow' | 'failed'): string {
  return why === 'slow'
    ? `${name} is off for this session: it kept running too slowly.`
    : `${name} is off for this session after an error.`;
}

const NOT_READY = 'session is not ready';
export const TRANSPORT_UNAVAILABLE = 'transport unavailable';

/** Opaque session id: stable across plugin reload, unique per CoreSession. */
export function newSessionId(clock?: Clock): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes);
  else {
    let n = (clock?.now() ?? 0) ^ (clock?.wallTimeMs() ?? 0) ^ 0x9e3779b9;
    for (let i = 0; i < 16; i++) {
      n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
      bytes[i] = n & 255;
    }
  }
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

const noop = (): void => {};

function byName(
  counts: ShortcutCounts | undefined,
): Record<string, { readonly expanded: number; readonly undone: number }> {
  const out: Record<string, { readonly expanded: number; readonly undone: number }> = Object.create(null);
  if (!counts) return out;
  const names = new Set([...Object.keys(counts.expanded), ...Object.keys(counts.undone)]);
  for (const name of names) {
    Object.defineProperty(out, name, {
      value: { expanded: counts.expanded[name] ?? 0, undone: counts.undone[name] ?? 0 },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function createSession(options: SessionOptions): Session {
  return new CoreSession(options);
}

class CoreSession implements Session {
  readonly ready: Promise<void>;
  readonly #adapter: Adapter;
  readonly #runner: HookRunner;
  readonly #options: SessionOptions;
  readonly #counters = new Counters();
  readonly #faults = new FaultBook();
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
  /** Phase 07. */
  #inline: InlineStage | undefined;
  /** Phase 37. Cached field ranges for `in-my-field-session`. */
  readonly #fields = new FieldSessions();
  /** Work started by keys the router already handled, not yet landed. */
  readonly #keyWork = new Set<Promise<void>>();
  #submitDeadlineMs = 0;
  #queue: Promise<void> = Promise.resolve();
  #seq = 0;
  #settled = 0;
  #subscribed = false;
  #disposed = false;
  /** First inline typo fix and first shortcut expansion; each names the restore keys once. */
  #firstTypoFix = false;
  #firstExpansion = false;
  /** Cancels the pending typing-pause timer (`onPause`). */
  #cancelPause: (() => void) | undefined;
  #disposing: Promise<void> | undefined;
  #killNotice: string | undefined;
  /** Phase 25: one notice per boundary; doctor reads the records. */
  #book = new BoundaryBook();
  /** Phase 32. */
  #review: ReviewLog | undefined;
  readonly #sessionId: string;
  readonly #clock: Clock;
  /** The host's startup notices as last stated (`SessionOptions.notices`, then `restateNotices`). */
  #startup: readonly string[];

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#startup = options.notices ?? [];
    this.#adapter = options.adapter;
    this.#runner = options.runner;
    this.#clock = options.clock ?? options.runner.clock;
    this.#sessionId = options.sessionId ?? newSessionId(this.#clock);
    this.#guard = new FailOpen(() => this.#kill(), options.failureLimit ?? FAILURE_LIMIT);
    this.ready = this.#start();
  }

  /** Phase 32: stable across applyPlugin; a new Session gets a new id. */
  get sessionId(): string {
    return this.#sessionId;
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
    this.#book = bookOf(adapter, this.#book);
    this.#hostCaps = hostCaps;
    this.#caps = { ...hostCaps, runtime: this.#runner.runtime };
    // Duplicate / missing / unknown IDs refuse before any executor load (r14 K1).
    const orderedIds = resolveOrder(this.#runner.ids(), this.#options.order);
    const loaded = await this.#runner.load(this.#caps);
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
    const coverage = inspectGuardCoverage(loaded, hostCaps);
    for (const row of coverage.records) {
      const text = this.#book.record(row);
      if (text) notice(text);
    }
    for (const plugin of loaded) {
      for (const path of plugin.missingOptional ?? []) {
        if (!path.startsWith('runtime.')) continue;
        const text = this.#book.record({
          boundary: 'missing-hook',
          evidence: { kind: 'measured-capability', detail: `${plugin.descriptor.id}:${path}` },
          action: 'suppress',
        });
        if (text) notice(text);
      }
    }
    const submitOpts = submitOptions({
      ...this.#options,
      clock: this.#clock,
      guardPolicy: this.#options.guardPolicy ?? (coverage.block ? 'final-boundary' : 'managed'),
    });
    this.#submitDeadlineMs = submitOpts.deadlineMs;
    // Phase 32: review panel for third-party edits. Hosts without ui.review
    // drop third-party draft:write (reviewCapabilityGate).
    this.#review = new ReviewLog({
      clock: submitOpts.clock,
      mode: this.#options.reviewThirdPartyEdits ?? 'always',
      notice,
      show: (panel: ReviewPanel | null, version: number) => {
        const show = this.#adapter.showReview;
        if (show) show.call(this.#adapter, panel, version);
        else if (panel) notice(panel.edits.map((e) => `[plugin ${e.pluginId}] ${e.after}`).join(' | '));
      },
    });
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
      // A refused send describes this draft; the notice goes when the draft changes.
      notice: (text: string) => presentation.notice(text, 'draft'),
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
      // In the one effects queue, so a committed hook's effects never overtake
      // those of an onChange that finished before it.
      applyEffects: (plugin, value, ticket: Ticket) => {
        const effects = this.#effects;
        if (!effects) return Promise.resolve();
        // The caller still sees a failure (an output limit is the plugin's fault).
        return new Promise<void>((resolve, reject) => {
          this.#enqueue(() => applyEffects(plugin, value, ticket, effects).then(resolve, reject));
        });
      },
      finishWord: (draft) => this.#inline?.finish(draft, view.state()) ?? null,
    });
    this.#submit = submit;
    // Phase 09: permission, rate and attribution gates next to 08's submit-in-progress.
    const rate = new EditRate(submitOpts.clock);
    const edits = new Edits({
      adapter,
      caps: hostCaps,
      view,
      intake,
      undo: this.#undo,
      counters,
      gates: [
        submit,
        permissionGate(),
        rate,
        attributionGate(() => hostCaps, notice),
        reviewCapabilityGate(() => hostCaps, notice),
        ...(this.#options.gates ?? []),
      ],
      notice,
      publish: (accepted) => this.#publish(accepted),
      noteApplied: (plugin, edit, draft) => {
        rate.noteApplied(plugin.id, plugin.builtin);
        if (plugin.id === 'names' || plugin.name === 'names') counters.nameAccepted++;
        // Phase 32
        this.#review?.noteApplied(plugin, edit, draft);
      },
    });
    this.#edits = edits;
    this.#effects = {
      view,
      edits,
      presentation,
      menu,
      counters,
      editable: isEditable,
      notice,
      fields: this.#fields,
    };

    // Phase 07: register built-in inline data after permissions, before keys.
    this.#inline = this.#registerInline(loaded, hostCaps, notice);

    for (const plugin of this.#plugins) {
      const source = loadedById.get(plugin.id);
      if (!source) continue;
      const { claims, notices } = validateClaims(plugin, source.descriptor.keys, hostCaps);
      plugin.claims = claims;
      for (const text of notices) notice(text);
      // Phase 32: reserved/mixed-script names are flagged; the id prefix remains.
      const flagged = nameNotice(plugin.id, plugin.name);
      if (flagged) notice(flagged);
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
        if (record.owner === 'names') counters.nameReverted++;
        const epoch = intake.epoch;
        this.#keyed(this.#enqueue(() => this.#edits?.restore(record, gesture, epoch) ?? Promise.resolve()));
      },
      acceptGhost: (plugin, text) => this.#acceptGhost(plugin, text),
      dispatch: (plugin, key) => this.#keyed(this.#schedule(plugin, 'onKey', key)),
      menuSelect: (plugin, item) => this.#keyed(this.#schedule(plugin, 'onMenuSelect', item)),
      render: () => {
        presentation.render();
        menu.render();
      },
      fields: this.#fields,
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
    // Phase 07: evaluate data only; native-completion Tab already `pass`es (phase 06).
    if (adapter.onInlineEdit) {
      this.#unsubscribe.push(
        adapter.onInlineEdit(
          guard.wrap((snapshot: InlineSnapshot) => this.#planInline(snapshot), { action: 'native' }),
        ),
      );
    }
    if (adapter.onInlineCommit) {
      this.#unsubscribe.push(
        adapter.onInlineCommit(guard.wrap((commit: InlineCommit) => this.#commitInline(commit), undefined)),
      );
    }
    if (adapter.onInlineReject) {
      this.#unsubscribe.push(
        adapter.onInlineReject(guard.wrap((rejection: InlineRejection) => this.#rejectInline(rejection), undefined)),
      );
    }
    this.#subscribed = true;
    for (const plugin of this.#plugins) {
      if (plugin.hooks.has('activate')) this.#schedule(plugin, 'activate', null);
      else if (!plugin.disabled) plugin.activated = true;
    }
    // The host's own startup lines; the first one given shows first.
    for (const text of [...this.#startup].reverse()) presentation.notice(text);
    // Newest of all, so a host with room for one line (Claude) shows it: an
    // installed plugin that could not start says so. A built-in's load
    // failure is in stats and doctor.
    for (const plugin of loaded) {
      if (plugin.loadError !== undefined && !plugin.builtin) {
        presentation.notice(`Plugin ${plugin.descriptor.id} did not start: ${plugin.loadError}`);
      }
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
   * Phase 07 evaluates inline data on `onInlineEdit` after a `pass`; a consumed
   * key still clears the Backspace-rejection window so a menu key is not "next".
   */
  #key(key: KeyId): 'consume' | 'pass' {
    this.#submit?.noteKey();
    // Phase 32: review panel owns Enter/Escape while open.
    const version = this.#intake?.draft.version ?? 0;
    const reviewKey = this.#review?.onKey(key, version);
    if (reviewKey === 'consume') return 'consume';
    if (reviewKey === 'approve') {
      void this.#adapter.requestSubmit?.('send');
      return 'consume';
    }
    const state = this.#adapter.getState();
    if (nativeUiOpen(state)) {
      const text = this.#book.record({
        boundary: 'native-ui',
        evidence: { kind: 'peer-declaration', detail: state.popup ? 'popup' : 'dialog' },
        action: 'defer',
      });
      if (text) this.#presentation?.notice(text, 'native-ui');
    }
    const result = this.#router?.route(key).result ?? 'pass';
    this.#inline?.noteKey(key);
    return result;
  }

  // Phase 07 ----------------------------------------------------------------

  #registerInline(
    loaded: readonly LoadedPlugin[],
    hostCaps: HostCapabilities,
    notice: (text: string) => void,
  ): InlineStage | undefined {
    const registered = loaded.flatMap((plugin) => this.#inlineRules(plugin, hostCaps, notice));
    if (!registered.length) return undefined;
    return createInlineStage(registered, hostCaps, () => this.#fields.frozen());
  }

  #inlineRules(plugin: LoadedPlugin, hostCaps: HostCapabilities, notice: (text: string) => void): RegisteredInline[] {
    const registered: RegisteredInline[] = [];
    const entry = this.#byId.get(plugin.descriptor.id);
    for (const rule of plugin.inline ?? []) {
      try {
        registered.push(
          registerRuleSet(rule, {
            owner: plugin.descriptor.id,
            builtin: plugin.builtin,
            permissions: entry?.permissions ?? plugin.descriptor.permissions,
            assets: plugin.assets,
            transportMaxBytes: hostCaps.inline.maxBytes,
          }),
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        notice(`${plugin.descriptor.name}: inline registration rejected: ${reason}`);
      }
    }
    return registered;
  }

  /** A replaced plugin's inline rule sets take the old ones' place (a reloaded shortcuts table). */
  #replaceInline(plugin: LoadedPlugin, hostCaps: HostCapabilities): void {
    const notice = (text: string) => this.#presentation?.notice(text);
    const rules = this.#inlineRules(plugin, hostCaps, notice);
    if (this.#inline) this.#inline.replaceOwner(plugin.descriptor.id, rules);
    else if (rules.length) this.#inline = createInlineStage(rules, hostCaps, () => this.#fields.frozen());
  }

  #planInline(snapshot: InlineSnapshot): InlineAnswer {
    return this.#inline?.plan(snapshot) ?? { action: 'native' };
  }

  #commitInline(commit: InlineCommit): void {
    const stage = this.#inline;
    if (!stage) return;
    const { corrections, deferred, shortcutExpanded, shortcutUndone, rejected } = stage.commit(commit);
    // `corrections` counts typo fixes and shortcut expansions alike; each has its own counter.
    this.#counters.inlineCorrections += corrections - shortcutExpanded;
    for (const word of rejected) this.#options.onRejectedWord?.(word);
    this.#counters.shortcutExpanded += shortcutExpanded;
    this.#counters.shortcutUndone += shortcutUndone;
    // The notice names what actually happened.
    const caps = this.#hostCaps;
    if (caps && corrections > shortcutExpanded && !this.#firstTypoFix) {
      this.#firstTypoFix = true;
      this.#presentation?.notice(firstFixNotice('typo', caps));
    } else if (caps && shortcutExpanded > 0 && !this.#firstExpansion) {
      this.#firstExpansion = true;
      this.#presentation?.notice(firstFixNotice('expansion', caps));
    }
    if (!deferred.length || commit.status !== 'applied') return;
    this.#enqueue(async () => {
      const edits = this.#edits;
      const view = this.#view;
      if (!edits || !view) return;
      let expectedVersion = commit.version;
      for (const request of deferred) {
        const plugin = this.#byId.get(request.owner);
        if (!plugin || plugin.disabled) return;
        const draft = view.draft;
        if (
          draft.version !== expectedVersion ||
          draft.text.slice(request.edit.from, request.edit.to) !== request.expected
        ) {
          this.#counters.commits.stale++;
          return;
        }
        const seq = ++this.#seq;
        this.#latest.set(`${plugin.id}\u0000onChange`, seq);
        const ticket = issueTicket(plugin.id, 'onChange', seq, view);
        const status = await edits.commit(plugin, { ...request.edit, baseVersion: draft.version }, ticket);
        if (status !== 'applied') return;
        expectedVersion = view.draft.version;
      }
    });
  }

  #rejectInline(rejection: InlineRejection): void {
    // A host-side Backspace (Claude) still joins the per-draft rejected set.
    this.#inline?.rejectWord(rejection.original);
    this.#options.onRejectedWord?.(rejection.original);
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
    this.#keyed(this.#enqueue(() => edits.commit(plugin, edit, ticket)));
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
      if (record.owner === 'names') this.#counters.nameReverted++;
      const epoch = intake.epoch;
      this.#keyed(this.#enqueue(() => this.#edits?.restore(record, 'undo-key', epoch) ?? Promise.resolve()));
      return;
    }
    if (action === 'murmo.menu') {
      if (state.popup !== null || state.dialog || !editable(state, draft)) return;
      intake.bumpEpoch();
      for (const plugin of this.#plugins) {
        if (plugin.disabled || !plugin.actions.has('murmo.menu') || !plugin.hooks.has('onAction')) continue;
        this.#keyed(this.#schedule(plugin, 'onAction', 'murmo.menu'));
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
    this.#keyed(this.#schedule(chosen.plugin, 'onMenuSelect', chosen.item));
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
      this.#inline?.observe(change);
      this.#submit?.noteChange(change.draft);
      presentation.dropStale(change.draft.version);
      this.#menu?.dropStale(change.draft.version);
      presentation.render();
      this.#menu?.render();
      for (const plugin of this.#plugins) this.#schedule(plugin, 'onChange', change, change);
    }
    const last = accepted[accepted.length - 1];
    if (last) this.#armPause(last.change);
  }

  /**
   * Restarts the typing pause: once the draft has not changed for
   * `LIMITS.pauseMs`, plugins with `onPause` run against the last change. The
   * wait is the core's timer, never time inside a hook, so it costs no budget.
   */
  #armPause(change: Change): void {
    this.#cancelPause?.();
    this.#cancelPause = undefined;
    const clock = this.#runner.clock;
    if (!this.#plugins.some((p) => !p.disabled && p.hooks.has('onPause'))) return;
    const version = change.draft.version;
    const fire = this.#guard.wrap(() => {
      this.#cancelPause = undefined;
      if (!this.#live || this.#intake?.draft.version !== version) return;
      for (const plugin of this.#plugins) this.#schedule(plugin, 'onPause', change, change);
    }, undefined);
    this.#cancelPause = clock.setTimer(fire, LIMITS.pauseMs);
  }

  /** Runs one hook; the promise settles once its effects applied (or were dropped). */
  #schedule(plugin: PluginEntry, hook: PluginHook, input: unknown, change?: Change): Promise<void> {
    const view = this.#view;
    const caps = this.#caps;
    const effects = this.#effects;
    if (!this.#live || !view || !caps || !effects || plugin.disabled || !plugin.hooks.has(hook)) {
      return Promise.resolve();
    }
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
    return this.#track(
      this.#runner.run(call).then(
        (value) => {
          if (hook === 'activate') plugin.activated = true;
          this.#faults.success(plugin, hook);
          return this.#enqueue(async () => {
            try {
              await applyEffects(plugin, value, ticket, effects);
            } catch (error) {
              // output-limit is a plugin fault; anything else is a core failure (a throwing gate).
              if ((error as { code?: unknown } | null)?.code === 'output-limit') this.#fault(plugin, hook, error);
              else this.#guard.record(error);
            }
          });
        },
        (error) => this.#fault(plugin, hook, error),
      ),
    );
  }

  #fault(plugin: PluginEntry, hook: PluginHook, error: unknown): void {
    const result = this.#faults.record(plugin, hook, error);
    if (result.action === 'ignore') return;
    this.#counters.faults++;
    // A strike is a count for stats and doctor, not news for the user; only
    // the disable it may lead to is shown, once.
    if (result.action === 'strike') {
      plugin.strikes[hook] = result.count;
      if (result.disable) this.#disable(plugin, result.message, 'slow');
      return;
    }
    if (result.action === 'notice' || result.action === 'degrade') {
      this.#presentation?.notice(result.message);
      return;
    }
    this.#disable(plugin, result.message, 'failed');
  }

  #executorHealth(): RunnerHealth {
    const fromRunner = this.#runner.health();
    if (fromRunner !== 'ok') return fromRunner;
    return this.#faults.health();
  }

  /** `reason` is the technical one for stats and doctor; the notice says it plainly. */
  #disable(plugin: PluginEntry, reason: string, why: 'slow' | 'failed'): void {
    if (plugin.disabled || this.#disposed) return;
    plugin.disabled = true;
    plugin.reason = reason;
    this.#presentation?.forget(plugin.id);
    this.#menu?.forget(plugin.id);
    this.#presentation?.notice(disabledNotice(plugin.name, why));
    this.#menu?.render();
    this.#track(this.#runner.unload(plugin.id));
  }

  /** Effects and restores run one at a time, in order, so two commits never interleave. */
  #enqueue(work: () => Promise<unknown>): Promise<void> {
    const task = this.#track(this.#queue.then(work));
    this.#queue = task;
    return task;
  }

  /** Work a key (or a pick in the host's menu) started; a send waits for it (`#afterKeyWork`). */
  #keyed(work: Promise<void>): void {
    this.#keyWork.add(work);
    void work.then(() => this.#keyWork.delete(work));
  }

  /**
   * Keys pressed before this send may have started work that has not landed
   * yet: a menu pick, a jump to a template field, a restore. The send waits for
   * it, within the submit deadline, so what goes out holds every edit those
   * keys asked for. True when there was any.
   */
  async #afterKeyWork(): Promise<boolean> {
    if (!this.#keyWork.size) return false;
    const clock = this.#clock;
    const until = clock.now() + this.#submitDeadlineMs;
    while (this.#keyWork.size) {
      const left = until - clock.now();
      if (left <= 0) break;
      let cancel = () => {};
      const expired = new Promise<boolean>((resolve) => {
        cancel = clock.setTimer(() => resolve(true), left);
      });
      const done = Promise.allSettled([...this.#keyWork]).then(() => false);
      const timedOut = await Promise.race([done, expired]);
      cancel();
      if (timedOut) break;
    }
    return true;
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
    if (!this.#live || !submit) return this.#announce(NOT_READY, tx.draft.version);
    try {
      // Phase 32: a dead helper cannot run a required guard.
      if (this.#executorHealth() === 'down' && this.#plugins.some((p) => p.guard)) {
        return this.#announce(TRANSPORT_UNAVAILABLE, tx.draft.version);
      }
      // Sends what the keys before this one made; the adapter's snapshot predates their edits.
      const waited = await this.#afterKeyWork();
      const draft = this.#intake?.draft;
      const moved = waited && draft !== undefined && draft.version !== tx.draft.version;
      const current: SubmitTransaction = moved ? { ...tx, draft } : tx;
      // The review panel is its own announcement.
      const review = this.#review?.intercept(current.draft.version);
      if (review) return review;
      const outcome = await submit.beforeSubmit(current);
      if (outcome.action === 'block') return this.#announce(outcome.reason, current.draft.version);
      return moved ? { ...outcome, version: current.draft.version } : outcome;
    } catch (error) {
      this.#guard.record(error);
      return this.#announce(error instanceof Error ? error.message : String(error), tx.draft.version);
    }
  }

  async finalGuard(input: { text: string; gesture: SubmitGesture }): Promise<SubmitOutcome> {
    await this.ready;
    const submit = this.#submit;
    const version = () => this.#intake?.draft.version ?? 0;
    if (!this.#live || !submit) return this.#announce(NOT_READY, version());
    try {
      const outcome = await submit.finalGuard(input);
      return outcome.action === 'block' ? this.#announce(outcome.reason, version()) : outcome;
    } catch (error) {
      this.#guard.record(error);
      return this.#announce(error instanceof Error ? error.message : String(error), version());
    }
  }

  /**
   * A refused send, said once on the status line: hosts show refusals only
   * through the core, so every block the session returns passes through here.
   * Before the session is up, the adapter's status is all there is.
   */
  #announce(reason: string, version: number): SubmitOutcome {
    try {
      const presentation = this.#presentation;
      if (presentation) presentation.notice(reason, 'draft');
      else this.#adapter.showStatus(reason, version);
    } catch (error) {
      // A host that cannot show it still gets the refusal.
      this.#guard.record(error);
    }
    return { action: 'block', reason };
  }

  replaceInline(rule: RegisteredInline): void {
    this.#inline?.swap(rule);
  }

  async applyPlugin(change: PluginChange): Promise<PluginActivation> {
    if (!this.#live) return 'error';
    if (change.action === 'disable') {
      const plugin = this.#byId.get(change.id);
      if (!plugin) return 'error';
      plugin.disabled = true;
      plugin.activated = false;
      this.#presentation?.render();
      this.#menu?.render();
      return 'disabled';
    }
    if (change.action === 'enable') {
      const plugin = this.#byId.get(change.id);
      if (!plugin) return 'error';
      plugin.disabled = false;
      if (plugin.hooks.has('activate')) this.#schedule(plugin, 'activate', null);
      else plugin.activated = true;
      this.#presentation?.render();
      this.#menu?.render();
      return plugin.hooks.has('activate') ? 'loaded' : 'activated';
    }
    if (change.action === 'remove') {
      const plugin = this.#byId.get(change.id);
      if (!plugin) return 'disabled';
      plugin.disabled = true;
      this.#plugins = this.#plugins.filter((entry) => entry.id !== change.id);
      this.#byId.delete(change.id);
      try {
        await this.#runner.unload(change.id);
      } catch {
        // already gone
      }
      this.#presentation?.render();
      this.#menu?.render();
      return 'disabled';
    }
    const loaded = change.plugin;
    const entry = entryOf(loaded);
    const existing = this.#byId.get(entry.id);
    if (existing) {
      const index = this.#plugins.indexOf(existing);
      this.#plugins[index] = entry;
    } else {
      const order = change.order ?? [];
      const self = order.indexOf(entry.id);
      const later = new Set(self < 0 ? [] : order.slice(self + 1));
      const at = this.#plugins.findIndex((plugin) => later.has(plugin.id));
      this.#plugins.splice(at < 0 ? this.#plugins.length : at, 0, entry);
    }
    this.#byId.set(entry.id, entry);
    if (loaded.loadError !== undefined && !loaded.builtin) {
      this.#presentation?.notice(`Plugin ${entry.id} did not start: ${loaded.loadError}`);
    }
    if (this.#hostCaps) {
      const { claims, notices } = validateClaims(entry, loaded.descriptor.keys, this.#hostCaps);
      entry.claims = claims;
      for (const text of notices) this.#presentation?.notice(text);
      this.#replaceInline(loaded, this.#hostCaps);
    }
    if (entry.disabled) return 'error';
    if (entry.hooks.has('activate')) this.#schedule(entry, 'activate', null);
    else entry.activated = true;
    this.#presentation?.render();
    this.#menu?.render();
    return entry.disabled ? 'error' : entry.hooks.has('activate') ? 'loaded' : 'activated';
  }

  restateNotices(notices: readonly string[]): void {
    const previous = this.#startup;
    this.#startup = [...notices];
    const presentation = this.#presentation;
    if (!presentation || this.#disposed) return;
    presentation.withdraw(previous.filter((text) => !notices.includes(text)));
    const added = notices.filter((text) => !previous.includes(text));
    // As at start: the first one given shows first.
    for (const text of [...added].reverse()) presentation.notice(text);
  }

  /** Per-draft state that a committed send drops (pending `.` and rejected words are 07/13). */
  #resetOnCommit(): void {
    this.#undo.clear();
    this.#inline?.clear();
    // Work in flight for the sent draft goes stale. A host that empties its
    // box before it confirms the send (Pi) already moved past that draft, and
    // the change that emptied it is still on its way to plugins: they must
    // see it, or they go on tracking the prompt that was sent.
    const intake = this.#intake;
    if (intake && intake.draft.text !== '') intake.bumpEpoch();
    this.#options.menu?.dismiss();
    this.#menu?.dismiss();
    this.#review?.reset();
    this.#presentation?.expireOnSend();
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
    this.#cancelPause?.();
    this.#cancelPause = undefined;
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
    this.#inline?.clear();
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
      executor: this.#executorHealth(),
      plugins: this.#plugins.map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        builtin: p.builtin,
        activated: p.activated,
        disabled: p.disabled,
        loaded: p.loaded,
        strikes: Object.values(p.strikes).reduce((n, c) => n + c, 0),
        denied: p.deniedEdits,
        ...(p.reason === undefined ? {} : { reason: p.reason }),
      })),
      disabled: this.#plugins.filter((p) => p.disabled).map((p) => p.id),
      notices,
      boundaries: this.#book.records,
      epoch: this.#intake?.epoch ?? 0,
      version: this.#intake?.draft.version ?? -1,
      undoDepth: this.#undo.depth + (this.#inline?.undoDepth() ?? 0),
      inlineCorrections: c.inlineCorrections,
      shortcutExpanded: c.shortcutExpanded,
      shortcutUndone: c.shortcutUndone,
      shortcutByName: byName(this.#inline?.shortcutCounts()),
      nameAccepted: c.nameAccepted,
      nameReverted: c.nameReverted,
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

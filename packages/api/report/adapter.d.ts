import type { PluginService, ProjectChange, ProjectReadResult } from './brokers.ts';
import type { HostCapabilities } from './caps.ts';
import type { Certainty, Change, Draft, DraftDelta, HostName, HostState, Range, SubmitGesture } from './draft.ts';
import type { ActionResult, Edit, EditResult, EffectType, HighlightMark, MenuItem } from './effects.ts';
import type { ActionId, KeyClaim, KeyId, PluginAction } from './keys.ts';
import type { DEADLINES, Permission } from './limits.ts';
import type { PluginManifest } from './manifest.ts';
import type { Cancellation, Clock, PluginContext, PluginFactory, PluginHook, SubmitCommitted, SubmitPosition, SubmitTransaction } from './plugin.ts';
export type { HostCapabilities } from './caps.ts';
export * from './index.ts';
export type Unsubscribe = () => void;
export interface HookRoute {
    /** Permissions a plugin must hold for the hook to run; `draft:read:full` satisfies `draft:read`. */
    readonly requires: readonly Permission[];
    /** The `DEADLINES` entry that bounds one call. */
    readonly deadline: keyof typeof DEADLINES;
}
/**
 * Every plugin hook and how it is gated. This is the list the helper parity gate
 * checks (phase 10): an executor must deliver every hook named here, so a route a
 * runtime drops can't stay hidden behind a fake host that delivers it (lesson 73).
 * A type test fails when `Plugin` gains a hook missing from this table.
 */
export declare const HOOKS: {
    readonly activate: {
        readonly requires: readonly [];
        readonly deadline: 'activateMs';
    };
    readonly onChange: {
        readonly requires: readonly ["draft:read"];
        readonly deadline: 'changeMs';
    };
    readonly onPause: {
        readonly requires: readonly ["draft:read"];
        readonly deadline: 'changeMs';
    };
    readonly onKey: {
        readonly requires: readonly [];
        readonly deadline: 'keyDispatchMs';
    };
    readonly onMenuSelect: {
        readonly requires: readonly [];
        readonly deadline: 'eventMs';
    };
    readonly onAction: {
        readonly requires: readonly [];
        readonly deadline: 'eventMs';
    };
    readonly onBeforeSubmit: {
        readonly requires: readonly ["submit"];
        readonly deadline: 'submitTotalMs';
    };
    readonly onSubmitCommitted: {
        readonly requires: readonly ["submit:observe", "draft:read"];
        readonly deadline: 'eventMs';
    };
    readonly onSubmitUnresolved: {
        readonly requires: readonly ["submit:observe"];
        readonly deadline: 'eventMs';
    };
    readonly onProjectFileChange: {
        readonly requires: readonly ["fs:project-read"];
        readonly deadline: 'eventMs';
    };
    readonly onAgentEvent: {
        readonly requires: readonly ["events:read"];
        readonly deadline: 'agentEventMs';
    };
    readonly deactivate: {
        readonly requires: readonly [];
        readonly deadline: 'eventMs';
    };
};
/** Context services and the permission each needs (none means always routed). */
export declare const SERVICE_ROUTES: {
    readonly clock: {
        readonly requires: readonly [];
    };
    readonly storage: {
        readonly requires: readonly [];
    };
    readonly 'project.read': {
        readonly requires: readonly ["fs:project-read"];
    };
    readonly 'project.list': {
        readonly requires: readonly ["project:list"];
    };
    readonly 'network.request': {
        readonly requires: readonly ["network"];
    };
    readonly 'git.query': {
        readonly requires: readonly ["project:git"];
    };
};
/** Effects and the permission each needs to apply. */
export declare const EFFECT_ROUTES: {
    readonly edit: {
        readonly requires: readonly ["draft:write"];
    };
    readonly ghost: {
        readonly requires: readonly ["draft:read"];
    };
    readonly menu: {
        readonly requires: readonly ["draft:read"];
    };
    readonly highlight: {
        readonly requires: readonly ["draft:read"];
    };
    readonly status: {
        readonly requires: readonly ["draft:read"];
    };
    readonly 'field-session': {
        readonly requires: readonly ["draft:read"];
    };
};
/**
 * When a declared permission is granted without an explicit host grant (phase 09
 * enforces): `declared`, unless the host restricts it; `builtin`, only for
 * host-installed built-ins; `explicit`, only with an explicit grant.
 */
export declare const PERMISSION_DEFAULTS: {
    readonly 'draft:read': 'declared';
    readonly 'draft:read:full': 'builtin';
    readonly 'submit:observe': 'declared';
    readonly 'draft:write': 'declared';
    readonly submit: 'declared';
    readonly network: 'explicit';
    readonly 'fs:project-read': 'explicit';
    readonly 'events:read': 'declared';
    readonly 'tools:guard': 'declared';
    readonly 'tools:rewrite': 'explicit';
    readonly 'context:write': 'declared';
    readonly 'agent:send': 'explicit';
    readonly 'agent:control': 'explicit';
    readonly 'messages:rewrite': 'explicit';
    readonly 'project:list': 'explicit';
    readonly 'project:git': 'explicit';
};
export interface PermissionRoutes {
    readonly hooks: readonly PluginHook[];
    readonly services: readonly PluginService[];
    readonly effects: readonly EffectType[];
}
/**
 * The hooks, services and effects a set of granted permissions opens.
 * `network` opens `network.request`; listing and git are their own services.
 */
export declare function routesFor(granted: readonly Permission[]): PermissionRoutes;
interface PluginSpecBase {
    /** Stable host-owned identity: grants, storage namespace, attribution. Unique per session. */
    readonly id: string;
    /** Trusted in-process factory. */
    readonly factory?: PluginFactory;
    /** Self-contained ES module source; required by the isolated executor. */
    readonly source?: string;
    /** User settings, resolved against the manifest schema before the factory runs. */
    readonly settings?: Readonly<Record<string, unknown>>;
    /** Binary assets, supplied once at load, never per change. */
    readonly assets?: Readonly<Record<string, ArrayBuffer>>;
    /** A guard whose load or activation fails still blocks every send. */
    readonly requiredGuard?: boolean;
    /** Host-reviewed admission; overrides the manifest's request. */
    readonly resources?: {
        readonly memoryMiB: number;
    };
    /** OS sandbox for this worker. Third-party specs set this; built-ins share a guest without it. */
    readonly sandbox?: boolean;
    /** Exact origins the `network` grant covers (scheme, host, port). */
    readonly networkOrigins?: readonly string[];
}
/**
 * A plugin as the host loads it. Only the host marks a spec `builtin` (our own
 * plugins, installed with Murmo); a plugin's files cannot. Every other spec
 * needs a manifest, so preflight runs before any of its code.
 */
export type PluginSpec = (PluginSpecBase & {
    readonly builtin: true;
    readonly manifest?: PluginManifest;
    /** Declarative inline rule sets; registered for built-ins only (phase 07). */
    readonly inline?: readonly InlineRules[];
}) | (PluginSpecBase & {
    readonly builtin?: false;
    readonly manifest: PluginManifest;
    readonly inline?: never;
});
/** Plugin metadata the executor reads at load, before activation. */
export interface PluginDescriptor {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly permissions: readonly Permission[];
    readonly guard: boolean;
    readonly keys: readonly KeyClaim[];
    readonly actions: readonly PluginAction[];
    /** Hooks the plugin implements. */
    readonly hooks: readonly PluginHook[];
}
/** Typed executor faults; only the budget kinds count toward `LIMITS.faultStrikes`. */
export type ExecutorFaultCode = 'cpu' | 'timeout' | 'memory' | 'cancelled' | 'exception' | 'output-limit' | 'transport';
export interface ExecutorFault {
    readonly code: ExecutorFaultCode;
    readonly pluginId: string;
    readonly hook: PluginHook | 'load';
    readonly message: string;
    /** Load generation of the guest that failed. */
    readonly generation?: number;
}
export interface ExecutionOptions {
    readonly timeoutMs: number;
    readonly signal?: Cancellation;
}
/**
 * Runs plugin code. `in-process` is for trusted code only: it can't preempt a
 * synchronous loop or an allocation. `isolated` runs one bounded guest per plugin.
 * Both reject with an `ExecutorFault`-shaped error.
 */
export interface Executor {
    readonly kind: 'in-process' | 'isolated';
    readonly clock: Clock;
    /**
     * Where this executor runs `spec`, for an executor that routes specs to
     * more than one place; absent means `kind` for every spec. A plugin's
     * `runtime.executor` is this, not the session's.
     */
    kindOf?(spec: PluginSpec): 'in-process' | 'isolated';
    load(spec: PluginSpec): Promise<PluginDescriptor>;
    run(id: string, hook: PluginHook, input: unknown, context: PluginContext, options: ExecutionOptions): Promise<unknown>;
    unload(id: string): Promise<void>;
    dispose(): Promise<void>;
    /** Diagnostics only, shape owned by `@murmo/executor` (phase 09). */
    stats(): unknown;
}
/** Durable storage backend; the core namespaces it by plugin ID (phase 14 implements it). */
export interface StorageBackend {
    load(namespace: string): Promise<string>;
    save(namespace: string, json: string): Promise<void>;
}
export interface ProjectTrustRequest {
    readonly pluginId: string;
    readonly root: string;
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly message: string;
}
/** Host broker for project reads; approval happens before activation, never inside a hook. */
export interface ProjectFiles {
    readonly root: string;
    readonly limits: {
        readonly maxFileBytes: number;
        readonly maxReadBytes: number;
        readonly maxReads: number;
    };
    authorize(pluginId: string, path?: string): Promise<boolean>;
    read(pluginId: string, path: string, signal?: Cancellation): Promise<ProjectReadResult>;
    onChange(callback: (event: ProjectChange) => void): Unsubscribe;
    dispose(): Promise<void>;
}
/** A merged-menu row: the plugin's item plus the owner the core set from the real plugin ID. */
export interface PresentedMenuItem extends MenuItem {
    readonly owner: string;
}
/** Host-owned record of a third-party edit; the plugin can't fake any of it. */
export interface EditAttribution {
    readonly pluginId: string;
    readonly label: string;
    readonly before: Draft;
}
export type ReviewFlag = 'zero-width' | 'bidi' | 'homoglyph' | 'off-screen';
/** One third-party edit as the review panel shows it. */
export interface ReviewEdit {
    readonly pluginId: string;
    readonly sequence: number;
    readonly from: number;
    readonly to: number;
    readonly before: string;
    readonly after: string;
    readonly onScreen: boolean;
    readonly flags: readonly ReviewFlag[];
}
/** Version-bound review of unreviewed third-party edits. */
export interface ReviewPanel {
    readonly version: number;
    readonly edits: readonly ReviewEdit[];
    readonly cooldownMs: number;
    readonly remainingMs: number;
}
export type ReviewAction = 'approve' | 'dismiss';
/** The pipeline's final answer for one submit attempt. */
export type SubmitOutcome = {
    readonly action: 'send';
    readonly coverage: SubmitPosition;
} | {
    readonly action: 'replace';
    readonly text: string;
    readonly coverage: SubmitPosition;
} | {
    readonly action: 'block';
    readonly reason: string;
};
/** What an adapter reports when the host accepted a submission; the core adds `level`. */
export type HostSubmitAccepted = Omit<SubmitCommitted, 'level'>;
/** A native semantic menu selection, bound to its owner, item and version. */
export interface MenuSelection {
    readonly pluginId: string;
    readonly itemId: string;
    readonly baseVersion: number;
}
/**
 * Immutable data registered before typing; evaluated by a trusted policy in the
 * core inside the host's native edit transaction. No plugin function runs here.
 */
export interface InlineRules {
    readonly id: string;
    /** Must equal the spec's ID. */
    readonly owner: string;
    /** Ascending; ties keep registration order. */
    readonly priority: number;
    readonly enabled: boolean;
    /** A policy compiled into the core, e.g. `english-word-boundary-v1`. */
    readonly policy: string;
    readonly table?: {
        readonly format: 'packed-sorted-ascii-v1';
        /** Key into `PluginSpec.assets`. */
        readonly asset: string;
        readonly sha256: string;
        readonly entries: number;
    };
    readonly language: 'en';
    readonly boundaries: ' .,;:!?';
    readonly case: 'preserve-title';
    readonly dot: 'wait-next-typed-key';
    readonly origin: 'fully-typed-span';
    readonly skip: readonly ('code' | 'path' | 'URL' | 'flag' | 'identifier' | 'foreign-letter-line')[];
    readonly replacements?: {
        readonly format: 'literal-utf8-v1';
        readonly entries: Readonly<Record<string, string>>;
        /** First-field cursor offset in the expansion, for hosts without Tab (Claude). */
        readonly cursors?: Readonly<Record<string, number>>;
    };
    /** Protected words, checked before any lookup. */
    readonly vocabulary?: readonly string[];
    /** Largest expansion applied inline (UTF-8 bytes); larger ones take the deferred path. */
    readonly inlineMaxInsertBytes: number;
    /** Largest expansion at all (UTF-8 bytes). */
    readonly maxInsertBytes: number;
    readonly rejectMemory: 'per-draft';
}
export interface InlineSnapshot {
    readonly transactionId: string;
    readonly version: number;
    readonly text: string;
    readonly cursor: number;
    readonly typedSpans: readonly Range[];
    readonly certainty: Certainty;
    readonly selection?: Range;
    readonly origin: 'typed' | 'paste' | 'unknown';
    /** Every splice of this native chunk, in order, in the uncorrected native chain. */
    readonly deltas: readonly DraftDelta[];
    /** The key whose transaction this is. */
    readonly key: {
        readonly id: KeyId;
        readonly inputText: string;
        readonly from: number;
        readonly to: number;
    };
    readonly state: HostState;
    /** `next-key` hosts: the authoritative backlog to repair. */
    readonly deferred?: {
        readonly before: Draft;
        readonly deltas: readonly DraftDelta[];
        readonly atVersion: number;
    };
}
export interface InlineCorrection {
    readonly from: number;
    readonly to: number;
    readonly insert: string;
    readonly original: string;
    readonly kind: 'typo' | 'shortcut' | 'undo';
}
export interface InlineReplay {
    readonly before: Draft;
    readonly deltas: readonly DraftDelta[];
    readonly typedSpans: readonly Range[];
    readonly corrections: readonly InlineCorrection[];
    readonly undoDepth: number;
}
export type InlineAnswer = {
    readonly action: 'native';
    readonly replay?: InlineReplay;
} | {
    readonly action: 'replace';
    readonly text: string;
    readonly cursor: number;
    readonly replay?: InlineReplay;
    readonly owner: string;
    readonly ruleId: string;
    readonly undo: {
        readonly beforeText: string;
        readonly beforeCursor: number;
        readonly rejectSeparator: boolean;
    };
};
/** The adapter's acknowledgement of what the host really committed for a transaction. */
export interface InlineCommit {
    readonly transactionId: string;
    readonly status: 'applied' | 'fallback' | 'stale' | 'cancelled';
    readonly text: string;
    readonly cursor: number;
    readonly version: number;
}
/**
 * The host itself undid an inline correction (Claude's Backspace outside the
 * shared key path), so the core can keep the word in the per-draft rejected set
 * after delete and retype (r13-claude-inline: persistent rejection needs it).
 */
export interface InlineRejection {
    /** The applied `InlineCommit` whose correction was rejected. */
    readonly transactionId: string;
    /** The word as typed before the correction (`InlineCorrection.original`). */
    readonly original: string;
    /** The draft after the rejection committed. */
    readonly text: string;
    readonly cursor: number;
    readonly version: number;
}
/**
 * One host integration. Every presentation call is version-bound and returns a
 * typed result; every subscription returns an unsubscribe. The synchronous
 * callbacks (`onKey`, `onInlineEdit`) evaluate data only and are never awaited.
 */
export interface Adapter {
    readonly host: {
        readonly name: HostName;
        readonly version: string;
    };
    /** Measured capabilities, published by `ready()`. */
    readonly caps: HostCapabilities;
    /** Run the real startup probes with notifications suppressed, then publish measured caps. */
    ready(): Promise<HostCapabilities>;
    getDraft(): Draft;
    getState(): HostState;
    /** Compare-and-set at the native commit; return the committed snapshot, not a later read. */
    applyEditIfVersion(edit: Edit, signal?: Cancellation): Promise<EditResult>;
    /** The same, with a host-owned attribution record; `unsupported` when the host can't attribute. */
    applyAttributedEditIfVersion(edit: Edit, attribution: EditAttribution, signal?: Cancellation): Promise<EditResult>;
    /** Exact restore of text, cursor, selection and typed spans. */
    restoreDraft(draft: Draft, expectedVersion: number, signal?: Cancellation): Promise<EditResult>;
    showGhost(text: string | null, baseVersion: number): ActionResult;
    /** Third-party ghosts; accepting one inserts only its text, never the attribution. */
    showAttributedGhost(text: string | null, baseVersion: number, pluginId: string): ActionResult;
    showMenu(items: readonly PresentedMenuItem[] | null, selected: number, baseVersion: number): ActionResult;
    showHighlight(ranges: readonly Range[] | null, baseVersion: number): ActionResult;
    /** Severity and message when `ui.highlightDiagnostics` is true. */
    showHighlightMarks?(marks: readonly HighlightMark[] | null, baseVersion: number): ActionResult;
    showStatus(text: string | null, baseVersion: number): ActionResult;
    /** Third-party edit review; required when `ui.review` is true. */
    showReview?(panel: ReviewPanel | null, baseVersion: number): ActionResult;
    /** Re-issue a send after review approval (the first gesture opened the review). */
    requestSubmit?(gesture: SubmitGesture): Promise<SubmitOutcome>;
    onDraftChange(callback: (change: Change) => void): Unsubscribe;
    onKey(callback: (key: KeyId) => 'consume' | 'pass'): Unsubscribe;
    /** Every configured send, queue and steer gesture, before the host clears the draft. */
    onBeforeSubmit(callback: (tx: SubmitTransaction) => Promise<SubmitOutcome>): Unsubscribe;
    /** Called inside the native edit transaction; never await the evaluator's caller. */
    onInlineEdit?(evaluate: (snapshot: InlineSnapshot) => InlineAnswer): Unsubscribe;
    onInlineCommit?(callback: (commit: InlineCommit) => void): Unsubscribe;
    onInlineReject?(callback: (rejection: InlineRejection) => void): Unsubscribe;
    onMenuSelect?(callback: (selection: MenuSelection) => void): Unsubscribe;
    onAction?(callback: (action: ActionId) => void): Unsubscribe;
    /** Only after native peers and the transport accepted the prompt; never for a block or newline. */
    onSubmitCommitted?(callback: (event: HostSubmitAccepted) => void): Unsubscribe;
}

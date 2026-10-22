/** The version manifests negotiate against (`api` ranges). Stays 2.0.0 until v1. */
export declare const API_VERSION = "2.0.0";
/**
 * The draft label shown to authors. Each breaking change before v1 bumps the
 * counter (`2.0-pre.1`, ...); scaffolds record it and `murmo plugin dev` warns
 * when it differs.
 */
export declare const API_DRAFT = "2.0-pre.1";
/**
 * Every permission a plugin can declare. A declaration is never a grant: the host
 * grants (see `PERMISSION_DEFAULTS` in `@murmo/api/adapter`).
 *
 * - `draft:read`: the draft with every non-typed UTF-16 unit masked (typed-only).
 * - `draft:read:full`: the whole draft, pasted text included.
 * - `submit:observe`: committed and unresolved send events, read-only.
 * - `draft:write`: versioned edits, ghosts, menus with edits.
 * - `submit`: warn or block a send; only host-installed built-ins may rewrite it.
 * - `network`: brokered HTTP to one exact origin disclosed in the manifest.
 * - `fs:project-read`: bounded UTF-8 reads inside the approved project root.
 * Event grants (preview, `@murmo/api/events`) are independent of draft grants:
 * - `events:read`: observe agent-loop events; never implies `draft:read`.
 * - `tools:guard`: deny a tool call at a real before-execution barrier.
 * - `tools:rewrite`: replace tool input/output (types only in the preview).
 * - `context:write`: stage hidden next-prompt context.
 * - `agent:send`: send a new prompt (off in the preview).
 * - `agent:control`: compaction / Stop continuation.
 * - `messages:rewrite`: stored or model-visible message text (types only).
 * - `project:list`: paged paths under the project root (gitignore, no symlink escape).
 * - `project:git`: read-only git queries served by the helper, never the guest.
 */
export declare const EVENT_PERMISSIONS: readonly ['events:read', 'tools:guard', 'tools:rewrite', 'context:write', 'agent:send', 'agent:control', 'messages:rewrite'];
export declare const PERMISSIONS: readonly ["draft:read", "draft:read:full", "submit:observe", "draft:write", "submit", "network", "fs:project-read", "events:read", "tools:guard", "tools:rewrite", "context:write", "agent:send", "agent:control", "messages:rewrite", "project:list", "project:git"];
export type Permission = (typeof PERMISSIONS)[number];
/**
 * Wall-clock budgets per hook call, before scaling by measured scheduler lag
 * (1 to `LIMITS.budgetScaleMax` times). A wall-clock deadline is scheduler
 * dependent, not an OS real-time guarantee.
 */
export declare const DEADLINES: {
    /** `activate`. */
    readonly activateMs: 50;
    /** `onChange`. */
    readonly changeMs: 100;
    /** `onKey`, after the synchronous claim decision. */
    readonly keyDispatchMs: 10;
    /** All `onBeforeSubmit` calls of one send attempt together. */
    readonly submitTotalMs: 50;
    /** Every other hook: menu selection, actions, committed and project-change events. */
    readonly eventMs: 50;
    /** `onAgentEvent`. The broker's guard budget is 40% of the native hook limit. */
    readonly agentEventMs: 2000;
};
export declare const LIMITS: {
    /** Plugin entry source (`.mjs`). */
    readonly sourceBytes: 1048576;
    /** Serialized result of one isolated hook call. */
    readonly responseBytes: 65536;
    /** Effects returned by one hook call; more disables the call's output. */
    readonly effectsPerCall: 128;
    /** Applied edits per rolling second per third-party plugin. */
    readonly editsPerSecond: 20;
    /** Default guest memory ceiling; more needs reviewed admission. */
    readonly defaultMemoryMiB: 8;
    /** Largest `resources.memoryMiB` a manifest may request (admission is separate). */
    readonly maxMemoryMiB: 128;
    /** All binary assets of one plugin. */
    readonly assetBytes: 4194304;
    /** `murmo.plugin.json`, UTF-8. */
    readonly manifestBytes: 65536;
    /** Serialized UTF-8 JSON of one plugin's storage namespace. */
    readonly storageBytes: 65536;
    /** Keys in one storage namespace. */
    readonly storageKeys: 64;
    /** UTF-16 units in one storage key. */
    readonly storageKeyUnits: 128;
    /** Consecutive typed budget faults in one hook that disable a plugin. */
    readonly faultStrikes: 3;
    /** Largest scheduler-lag multiplier applied to `DEADLINES`. */
    readonly budgetScaleMax: 8;
    /** One project file read. */
    readonly projectFileBytes: 262144;
    /** All project reads of one plugin per session. */
    readonly projectSessionBytes: 1048576;
    /** Project read attempts of one plugin per session. */
    readonly projectReads: 128;
    /** One brokered network request body. */
    readonly networkRequestBytes: 65536;
    /** One brokered network response body. */
    readonly networkResponseBytes: 262144;
    /** Brokered network requests per plugin per rolling minute. */
    readonly networkRequestsPerMinute: 10;
    /** Metadata bytes of one project listing snapshot. */
    readonly projectListBytes: 1048576;
    /** Paths in one project listing snapshot. */
    readonly projectListEntries: 10000;
    /** Paths returned on one listing page. */
    readonly projectListPage: 256;
};
/**
 * Permissions that need an explicit per-permission confirmation at add, even
 * when they also appear in `--grant`. Shown in `murmo plugin list`.
 */
export declare const HIGH_TRUST_PERMISSIONS: readonly ['draft:read:full', 'network', 'project:git'];

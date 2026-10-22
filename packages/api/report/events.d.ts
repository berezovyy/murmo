import type { ActionResult, Effect } from './effects.ts';
import { EVENT_PERMISSIONS } from './limits.ts';
import type { Plugin, PluginContext } from './plugin.ts';
/** Stable version manifests negotiate in the `events` range. */
export declare const EVENTS_VERSION = "0.4.0";
/** Preview label. Breaking changes bump this independently of `API_DRAFT`. */
export declare const EVENTS_DRAFT = "0.4-preview";
export { EVENT_PERMISSIONS };
export type EventPermission = (typeof EVENT_PERMISSIONS)[number];
/**
 * Native command-hook timeout Murmo writes on Claude and Codex (against the
 * 600 s host default). A deny after this limit is discarded and the tool runs.
 */
export declare const EVENTS_NATIVE_TIMEOUT_MS = 5000;
/** Guard budget inside Murmo: 40% of the native limit, so a late deny is never sent. */
export declare const EVENTS_GUARD_BUDGET_MS = 2000;
export declare const EVENTS_LIMITS: {
    readonly nativeTimeoutMs: 5000;
    readonly guardBudgetMs: 2000;
    /** Per-plugin observer FIFO: event count. */
    readonly queueCapacity: 256;
    /** Per-plugin observer FIFO: JSON payload bytes. */
    readonly queueBytes: 1048576;
    /** Observer events older than this (adapter monotonic clock) are dropped with a gap. */
    readonly maxAgeMs: 10000;
    /** A queue overflowing this long records a typed fault; three in a row disable. */
    readonly overflowFaultMs: 30000;
    /** GhostProposal expiry from receivedAtMs. */
    readonly ghostExpiryMs: 30000;
};
/** Released Codex 0.163.0 lifecycle hooks (not main's extra Pre/PostModelRequest). */
export declare const CODEX_RELEASED_HOOKS: readonly ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'];
export type CodexReleasedHook = (typeof CODEX_RELEASED_HOOKS)[number];
export declare const AGENT_EVENT_KINDS: readonly ['session.start', 'session.end', 'prompt.submit', 'message.delta', 'message.complete', 'tool.before', 'tool.after', 'tool.error', 'permission.request', 'step.end', 'turn.end', 'agent.run.start', 'agent.run.end', 'agent.idle', 'turn.error', 'compact.before', 'compact.after', 'subagent.start', 'subagent.end', 'model.before', 'model.after', 'retry.request', 'interrupt', 'delivery.gap'];
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];
export type EvidenceLevel = 'live' | 'source' | 'replay' | 'unverified';
export type EventDeadline = {
    readonly kind: 'bounded';
    readonly ms: number;
} | {
    readonly kind: 'none' | 'unknown';
};
export interface EventBuffer {
    readonly capacity: number | 'unbounded' | 'unknown';
    readonly overflow: 'gap' | 'disconnect' | 'backpressure' | 'unknown';
    readonly replay: 'none' | 'snapshot' | 'durable' | 'unknown';
}
export interface GuardCoverage {
    readonly position: 'before-native-peers' | 'after-native-peers' | 'unknown';
    readonly finalBoundary: boolean | 'unknown';
    readonly nestedTools: boolean | 'unknown';
    readonly postRewriteValidation: 'adapter' | 'native' | 'none' | 'unknown';
}
export interface EventCapability {
    readonly observe: boolean;
    readonly block: boolean;
    readonly modify: boolean;
    readonly addContext: boolean;
    readonly route: string;
    readonly delivery: 'barrier' | 'notification' | 'unsupported';
    readonly modifications?: readonly ('tool-input' | 'tool-output' | 'message-text' | 'prompt-text' | 'compaction' | 'permission' | 'retry')[];
    readonly evidence: EvidenceLevel;
    readonly coverage: string;
    readonly deadline: EventDeadline;
    readonly cancellation: boolean | 'unknown';
    readonly failure: 'allow' | 'deny' | 'host-defined' | 'unknown';
    readonly buffer?: EventBuffer;
    readonly guard?: GuardCoverage;
}
export type DisplayTarget = 'native-assistant' | 'native-user' | 'native-tool-result' | 'custom-message' | 'panel' | 'code-block';
export interface DisplayCapability {
    readonly badges: boolean;
    readonly collapse: boolean;
    readonly transformText: boolean;
    readonly customRenderer: boolean;
    readonly route: string;
    readonly evidence: EvidenceLevel;
}
export type ContextTarget = 'next-accepted-human-prompt' | 'next-accepted-prompt' | 'next-agent-run' | 'next-model-step';
export interface AgentCapabilities {
    readonly events: Partial<Record<AgentEventKind, EventCapability>>;
    readonly contextTargets?: readonly ContextTarget[];
    /** Empty means unsupported; independent modes may coexist. */
    readonly sendPromptModes: readonly ('idle' | 'queue' | 'steer')[];
    readonly sendReceipts: {
        readonly acceptance: 'authoritative' | 'unknown';
        readonly delivery: 'authoritative' | 'unknown';
        readonly atomicIdle: boolean | 'unknown';
    };
    readonly display: Partial<Record<DisplayTarget, DisplayCapability>>;
}
export type EventOutcome = 'completed' | 'failed' | 'interrupted' | 'continuing' | 'blocked' | 'cancelled' | 'unknown';
export interface AgentEvent {
    readonly kind: AgentEventKind;
    readonly host: string;
    readonly sessionId: string;
    readonly turnId?: string;
    readonly runId?: string;
    readonly stepId?: string;
    readonly agentId?: string;
    readonly itemId?: string;
    readonly nativeEventId?: string;
    readonly nativeSequence?: string | number;
    readonly partId?: string;
    readonly ordinal?: number;
    readonly parentToolCallId?: string;
    /** Adapter-local arrival order, not global causal or durable ordering. */
    readonly sequence: number;
    /** Adapter-local monotonic clock, not wall time. */
    readonly receivedAtMs: number;
    readonly sourceEvent: string;
    readonly lifecycle?: {
        readonly scope: 'durable-session' | 'attachment' | 'plugin-runtime' | 'unknown';
        readonly reason: 'created' | 'attached' | 'switched' | 'reloaded' | 'detached' | 'deleted' | 'ended' | 'unknown';
    };
    readonly submission?: {
        readonly id?: string;
        readonly phase: 'prepared' | 'accepted' | 'queued' | 'delivered' | 'cancelled' | 'unknown';
        readonly source: 'human' | 'plugin' | 'rpc' | 'unknown';
    };
    readonly tool?: {
        readonly name: string;
        readonly input?: unknown;
        readonly output?: unknown;
        readonly structuredContent?: unknown;
        readonly failed?: boolean;
        readonly executed?: boolean;
        readonly outcome?: EventOutcome;
        readonly guardId?: string;
        readonly reason?: string;
    };
    readonly message?: {
        readonly role: 'user' | 'assistant' | 'toolResult' | 'custom';
        readonly text: string;
        readonly delta?: string;
        readonly content?: unknown;
        readonly completeness?: 'delta' | 'part' | 'complete';
    };
    readonly permission?: {
        readonly action: string;
        readonly resources: unknown[];
        readonly effect?: unknown;
    };
    readonly error?: {
        readonly code?: string;
        readonly message: string;
    };
    readonly freshness?: {
        readonly deliveredAtMs?: number;
        readonly queueAgeMs?: number;
        readonly expiresAtMs?: number;
    };
    readonly outcome?: EventOutcome;
    readonly gap?: {
        readonly dropped: number;
        readonly coalesced: number;
        readonly expired: number;
    };
    readonly raw?: unknown;
}
export type ContinueDecision = {
    readonly action: 'continue';
    readonly context?: string;
};
export type BlockDecision = {
    readonly action: 'block';
    readonly reason: string;
};
export type ToolInputDecision = {
    readonly action: 'replace-tool-input';
    readonly input: unknown;
    readonly reason?: string;
};
export type ToolOutputDecision = {
    readonly action: 'replace-tool-output';
    readonly output: unknown;
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
};
export type MessageDecision = {
    readonly action: 'replace-message';
    readonly message: NonNullable<AgentEvent['message']>;
} | {
    readonly action: 'replace-message-text';
    readonly text: string;
};
export type PromptDecision = {
    readonly action: 'replace-prompt-text';
    readonly text: string;
};
export type PermissionDecision = {
    readonly action: 'permission';
    readonly decision: 'allow' | 'deny' | 'ask';
    readonly reason?: string;
};
export type CompactionDecision = {
    readonly action: 'replace-compaction';
    readonly value: unknown;
};
export type RetryDecision = {
    readonly action: 'retry';
    readonly retry: boolean;
    readonly delayMs?: number;
};
export type ContinueAgentDecision = {
    readonly action: 'continue-agent';
    readonly reason: string;
};
export interface EventDecisionsByKind {
    readonly 'tool.before': ContinueDecision | BlockDecision | ToolInputDecision;
    readonly 'tool.after': ContinueDecision | ToolOutputDecision;
    readonly 'tool.error': ContinueDecision | ToolOutputDecision;
    readonly 'message.delta': ContinueDecision | MessageDecision;
    readonly 'message.complete': ContinueDecision | MessageDecision;
    readonly 'prompt.submit': ContinueDecision | BlockDecision | PromptDecision;
    readonly 'permission.request': ContinueDecision | PermissionDecision;
    readonly 'compact.before': ContinueDecision | BlockDecision | CompactionDecision;
    readonly 'turn.end': ContinueDecision | ContinueAgentDecision;
    readonly 'agent.run.end': ContinueDecision | ContinueAgentDecision;
    readonly 'retry.request': ContinueDecision | RetryDecision;
}
export type EventDecision = EventDecisionsByKind[keyof EventDecisionsByKind];
export interface GhostProposal {
    readonly action: 'propose-ghost';
    readonly text: string;
    readonly expiresAtMs: number;
    readonly origin: {
        readonly sessionId: string;
        readonly runId?: string;
        readonly eventSequence: number;
    };
    readonly when: 'empty-native-idle';
}
export type AgentEventResult = undefined | Effect[] | EventDecision | GhostProposal;
export interface AgentActionResult extends ActionResult {
    readonly submissionId?: string;
    readonly phase?: 'prepared' | 'accepted' | 'queued' | 'delivered' | 'cancelled' | 'unknown';
    readonly source?: 'human' | 'plugin' | 'rpc' | 'unknown';
    readonly sessionId?: string;
    readonly draftVersion?: number;
    /** Accepted proposal is not proof of visible paint. */
    readonly presentation?: 'accepted' | 'rendered' | 'unverified';
}
export interface AgentApi {
    readonly caps: AgentCapabilities;
    addNextPromptContext(text: string, options?: {
        id?: string;
        expiresAfterMs?: number;
    }): Promise<AgentActionResult>;
    addContext?(text: string, options: {
        target: ContextTarget;
        id?: string;
        expiresAfterMs?: number;
    }): Promise<AgentActionResult>;
    sendPrompt(text: string, mode: 'idle' | 'queue' | 'steer'): Promise<AgentActionResult>;
}
export interface AgentContext extends PluginContext {
    readonly agent: AgentApi;
}
export interface AgentPlugin extends Omit<Plugin, 'permissions'> {
    readonly permissions: readonly (Plugin['permissions'][number] | EventPermission)[];
    readonly events?: readonly AgentEventKind[];
    onAgentEvent?(event: AgentEvent, ctx: AgentContext): AgentEventResult | Promise<AgentEventResult>;
}
export declare function isEventPermission(name: string): name is EventPermission;
export declare function isAgentEventKind(value: string): value is AgentEventKind;
export declare function isBarrierKind(_kind: AgentEventKind, cap: EventCapability | undefined): boolean;
export declare function unsupportedResult(reason: string): AgentActionResult;

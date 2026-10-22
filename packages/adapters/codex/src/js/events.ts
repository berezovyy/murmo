// Codex 0.163.0 lifecycle hooks via `murmo hook`. 12 released hooks, not main's
// Pre/PostModelRequest. Fail-open continue when the wrapper is missing.

import type { Capabilities, Clock, Draft, HostState } from '@murmo/api';
import type { AgentEvent, AgentPlugin, EventDecision } from '@murmo/api/events';
import { CODEX_RELEASED_HOOKS } from '@murmo/api/events';
import { codexEventCaps, EventBroker, type EventPluginRef, type GhostSink } from '@murmo/core';
import { type AuditSink, createAudit, createNextGhost, createToolGuard, createTurnContext } from '@murmo/plugin-events';

export { CODEX_RELEASED_HOOKS };

export function samplePlugins(
  enabled: ReadonlySet<string>,
  audit: AuditSink,
): { ref: EventPluginRef; plugin: AgentPlugin }[] {
  const out: { ref: EventPluginRef; plugin: AgentPlugin }[] = [];
  const add = (id: string, plugin: AgentPlugin) => {
    out.push({
      ref: {
        id,
        builtin: true,
        permissions: [...plugin.permissions],
        ...(plugin.events ? { events: plugin.events } : {}),
      },
      plugin,
    });
  };
  if (enabled.has('audit')) add('audit', createAudit(audit));
  if (enabled.has('tool-guard')) add('tool-guard', createToolGuard());
  if (enabled.has('turn-context')) add('turn-context', createTurnContext());
  if (enabled.has('next-ghost')) add('next-ghost', createNextGhost());
  return out;
}

export function createCodexBroker(options: {
  readonly clock: Clock;
  readonly hostVersion: string;
  readonly enabled: ReadonlySet<string>;
  readonly audit: AuditSink;
  readonly draft: () => Draft;
  readonly state: () => HostState;
  readonly sessionId: () => string;
  readonly hostCaps: Capabilities;
  readonly ghost: GhostSink;
}): EventBroker {
  const samples = samplePlugins(options.enabled, options.audit);
  const byId = new Map(samples.map((s) => [s.ref.id, s.plugin]));
  return new EventBroker({
    clock: options.clock,
    host: 'codex',
    hostVersion: options.hostVersion,
    caps: codexEventCaps(),
    plugins: () => samples.map((s) => s.ref),
    dispatch: (ref, event, ctx) => byId.get(ref.id)?.onAgentEvent?.(event, ctx),
    draft: options.draft,
    state: options.state,
    ghost: options.ghost,
    sessionId: options.sessionId,
    hostCaps: options.hostCaps,
    ownedBarrierFailure: 'allow',
  });
}

export function nativeToKind(eventName: string): AgentEvent['kind'] | undefined {
  switch (eventName) {
    case 'SessionStart':
      return 'session.start';
    case 'SessionEnd':
      return 'session.end';
    case 'UserPromptSubmit':
      return 'prompt.submit';
    case 'PreToolUse':
      return 'tool.before';
    case 'PostToolUse':
      return 'tool.after';
    case 'PermissionRequest':
      return 'permission.request';
    case 'PreCompact':
      return 'compact.before';
    case 'PostCompact':
      return 'compact.after';
    case 'SubagentStart':
      return 'subagent.start';
    case 'SubagentStop':
      return 'subagent.end';
    case 'Stop':
      return 'agent.idle';
    case 'Interrupt':
      return 'interrupt';
    default:
      return undefined;
  }
}

function extraOf(kind: AgentEvent['kind'], input: Record<string, unknown>): Partial<AgentEvent> {
  if (kind === 'tool.before' || kind === 'tool.after') {
    return {
      tool: {
        name: String(input.tool_name ?? ''),
        input: input.tool_input,
        output: input.tool_output,
        executed: kind === 'tool.after',
      },
    };
  }
  if (kind === 'prompt.submit') {
    return {
      message: { role: 'user', text: String(input.prompt ?? '') },
      submission: { phase: 'accepted', source: 'unknown' },
    };
  }
  if (kind === 'agent.idle') {
    return {
      message: { role: 'assistant', text: String(input.last_assistant_message ?? '') },
      outcome: 'completed',
    };
  }
  return {};
}

export function handleCodexHookSync(
  broker: EventBroker,
  input: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  const eventName = String(input.hook_event_name ?? input.event ?? '');
  const kind = nativeToKind(eventName);
  if (!kind) return continueReply(eventName);
  const extra = extraOf(kind, input);
  const decision = broker.decideSync({
    kind,
    host: 'codex',
    sessionId,
    sourceEvent: eventName,
    ...extra,
  });
  if (decision.action === 'block') {
    return {
      hookSpecificOutput: {
        hookEventName: eventName,
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    };
  }
  return continueReply(eventName);
}

export async function handleCodexHook(
  broker: EventBroker,
  input: Record<string, unknown>,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const eventName = String(input.hook_event_name ?? input.event ?? '');
  const kind = nativeToKind(eventName);
  if (!kind) return continueReply(eventName);
  const extra = extraOf(kind, input);
  const decision: EventDecision = await broker.ingest({
    kind,
    host: 'codex',
    sessionId,
    sourceEvent: eventName,
    ...extra,
  });
  if (decision.action === 'block') {
    return {
      hookSpecificOutput: {
        hookEventName: eventName,
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    };
  }
  const context = 'context' in decision && typeof decision.context === 'string' ? decision.context : undefined;
  if (context) {
    return {
      hookSpecificOutput: { hookEventName: eventName, additionalContext: context },
    };
  }
  return continueReply(eventName);
}

export function continueReply(eventName: string): Record<string, unknown> {
  return {
    hookSpecificOutput: { hookEventName: eventName, permissionDecision: 'allow' },
  };
}

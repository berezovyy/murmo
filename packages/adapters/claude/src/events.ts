// Claude classic hooks + mods. Never register Interrupt. Duplicate classic
// context is disabled when mods are active (E13). Helpers stay at module scope.

import type { Capabilities, Clock, Draft, HostState } from '@murmo/api';
import type { AgentEvent, AgentPlugin } from '@murmo/api/events';
import { EVENTS_NATIVE_TIMEOUT_MS } from '@murmo/api/events';
import { claudeEventCaps, EventBroker, type EventPluginRef, type GhostSink } from '@murmo/core';
import { type AuditSink, createAudit, createNextGhost, createToolGuard, createTurnContext } from '@murmo/plugin-events';

export const CLAUDE_EVENT_TIMEOUT_MS = EVENTS_NATIVE_TIMEOUT_MS;

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

export function createClaudeBroker(options: {
  readonly clock: Clock;
  readonly hostVersion: string;
  readonly mods: boolean;
  readonly enabled: ReadonlySet<string>;
  readonly audit: AuditSink;
  readonly draft: () => Draft;
  readonly state: () => HostState;
  readonly sessionId: () => string;
  readonly hostCaps: Capabilities;
  readonly ghost: GhostSink;
}): { broker: EventBroker; samples: { ref: EventPluginRef; plugin: AgentPlugin }[] } {
  const samples = samplePlugins(options.enabled, options.audit);
  const byId = new Map(samples.map((s) => [s.ref.id, s.plugin]));
  const broker = new EventBroker({
    clock: options.clock,
    host: 'claude',
    hostVersion: options.hostVersion,
    caps: claudeEventCaps(options.mods),
    plugins: () => samples.map((s) => s.ref),
    dispatch: (ref, event, ctx) => byId.get(ref.id)?.onAgentEvent?.(event, ctx),
    draft: options.draft,
    state: options.state,
    ghost: options.ghost,
    sessionId: options.sessionId,
    hostCaps: options.hostCaps,
    ownedBarrierFailure: 'allow',
  });
  return { broker, samples };
}

export function ingestClaudeHook(
  broker: EventBroker,
  eventName: string,
  input: Record<string, unknown>,
  sessionId: string,
): Promise<import('@murmo/api/events').EventDecision> {
  let extra: Partial<AgentEvent> = {};
  let kind: AgentEvent['kind'] = 'session.start';
  if (eventName === 'PreToolUse') {
    kind = 'tool.before';
    extra = {
      tool: { name: String(input.tool_name ?? input.toolName ?? ''), input: input.tool_input ?? input.toolInput },
    };
  } else if (eventName === 'PostToolUse') {
    kind = 'tool.after';
    extra = {
      tool: {
        name: String(input.tool_name ?? ''),
        output: input.tool_output ?? input.toolResponse,
        executed: true,
      },
    };
  } else if (eventName === 'UserPromptSubmit' || eventName === 'prompt.submit') {
    kind = 'prompt.submit';
    extra = {
      message: { role: 'user', text: String(input.prompt ?? input.text ?? '') },
      submission: { phase: 'accepted', source: 'human' },
    };
  } else if (eventName === 'Stop' || eventName === 'turn.complete') {
    kind = 'turn.end';
    extra = {
      message: { role: 'assistant', text: String(input.last_assistant_message ?? input.text ?? '') },
      outcome: 'completed',
    };
  } else if (eventName === 'SessionStart' || eventName === 'session.start') kind = 'session.start';
  else if (eventName === 'SessionEnd' || eventName === 'session.end') kind = 'session.end';
  else return Promise.resolve({ action: 'continue' });
  return broker.ingest({ kind, host: 'claude', sessionId, sourceEvent: eventName, ...extra });
}

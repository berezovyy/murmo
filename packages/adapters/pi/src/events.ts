// Pi 1.3.0 extension events. agent.idle is agent_settled, not turn_end (E8).
// tool_call throw blocks. next-accepted-human-prompt stays unsupported (E12).

import type { Capabilities, Clock, Draft, HostState } from '@murmo/api';
import type { AgentEvent, AgentPlugin, EventDecision } from '@murmo/api/events';
import { EventBroker, type EventPluginRef, type GhostSink, piEventCaps } from '@murmo/core';
import { type AuditSink, createAudit, createNextGhost, createToolGuard, createTurnContext } from '@murmo/plugin-events';
import type { PiHost } from './types.ts';

export interface PiEventsHandle {
  readonly broker: EventBroker;
  dispose(): void;
}

function textOf(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part === 'object' && (part as { type?: string }).type === 'text')
    .map((part) => String((part as { text?: unknown }).text ?? ''))
    .join('');
}

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

export function attachPiEvents(
  pi: PiHost,
  options: {
    readonly clock: Clock;
    readonly hostVersion: string;
    readonly failOpen: boolean;
    readonly enabled: ReadonlySet<string>;
    readonly audit: AuditSink;
    readonly draft: () => Draft;
    readonly state: () => HostState;
    readonly sessionId: () => string;
    readonly hostCaps: Capabilities;
    readonly ghost: GhostSink;
  },
): PiEventsHandle {
  const samples = samplePlugins(options.enabled, options.audit);
  const byId = new Map(samples.map((s) => [s.ref.id, s.plugin]));
  const broker = new EventBroker({
    clock: options.clock,
    host: 'pi',
    hostVersion: options.hostVersion,
    caps: piEventCaps(options.failOpen),
    plugins: () => samples.map((s) => s.ref),
    dispatch: (ref, event, ctx) => {
      const plugin = byId.get(ref.id);
      return plugin?.onAgentEvent?.(event, ctx);
    },
    draft: options.draft,
    state: options.state,
    ghost: options.ghost,
    sessionId: options.sessionId,
    hostCaps: options.hostCaps,
    ownedBarrierFailure: options.failOpen ? 'allow' : 'deny',
  });
  const off: Array<() => void> = [];
  const send = async (
    kind: AgentEvent['kind'],
    sourceEvent: string,
    ctx: unknown,
    extra: Partial<AgentEvent> = {},
  ): Promise<EventDecision> => {
    const session = ctx as { sessionManager?: { getSessionId?: () => string } };
    return broker.ingest({
      kind,
      host: 'pi',
      sessionId: session.sessionManager?.getSessionId?.() ?? options.sessionId(),
      sourceEvent,
      ...extra,
    });
  };

  off.push(
    pi.on('session_start', (_e, ctx) => send('session.start', 'session_start', ctx)),
    pi.on('session_shutdown', (_e, ctx) => send('session.end', 'session_shutdown', ctx)),
    pi.on('input', (event, ctx) =>
      send('prompt.submit', 'input', ctx, {
        message: { role: 'user', text: String((event as { text?: unknown })?.text ?? '') },
        submission: {
          phase: 'accepted',
          source: (event as { source?: string }).source === 'interactive' ? 'human' : 'unknown',
        },
      }),
    ),
    pi.on('message_update', (event, ctx) => {
      const e = event as { assistantMessageEvent?: { type?: string; delta?: string }; message?: unknown };
      if (e.assistantMessageEvent?.type !== 'text_delta') return;
      const delta = e.assistantMessageEvent.delta;
      return send('message.delta', 'message_update', ctx, {
        message: {
          role: 'assistant',
          text: textOf(e.message),
          ...(delta === undefined ? {} : { delta }),
        },
      });
    }),
    pi.on('message_end', (event, ctx) => {
      const e = event as { message?: { role?: string } };
      if (e.message?.role !== 'assistant') return;
      return send('message.complete', 'message_end', ctx, {
        message: { role: 'assistant', text: textOf(e.message) },
      });
    }),
    pi.on('tool_call', async (event, ctx) => {
      const e = event as { toolCallId?: string; toolName?: string; input?: unknown };
      const decision = await send('tool.before', 'tool_call', ctx, {
        ...(e.toolCallId === undefined ? {} : { itemId: e.toolCallId }),
        tool: { name: String(e.toolName ?? ''), input: e.input },
      });
      if (decision.action === 'block') return { block: true, reason: decision.reason };
    }),
    pi.on('tool_result', (event, ctx) => {
      const e = event as {
        toolCallId?: string;
        toolName?: string;
        input?: unknown;
        content?: unknown;
        isError?: boolean;
      };
      return send(e.isError ? 'tool.error' : 'tool.after', 'tool_result', ctx, {
        ...(e.toolCallId === undefined ? {} : { itemId: e.toolCallId }),
        tool: {
          name: String(e.toolName ?? ''),
          input: e.input,
          output: e.content,
          failed: e.isError === true,
          executed: e.isError !== true,
        },
      });
    }),
    pi.on('turn_end', (event, ctx) => {
      const e = event as { turnIndex?: number; messageEntryId?: string; message?: unknown; outcome?: string };
      const outcome =
        e.outcome === 'completed'
          ? 'completed'
          : e.outcome === 'aborted'
            ? 'interrupted'
            : e.outcome === 'error'
              ? 'failed'
              : 'unknown';
      return send('step.end', 'turn_end', ctx, {
        turnId: String(e.turnIndex ?? ''),
        ...(e.messageEntryId === undefined ? {} : { itemId: e.messageEntryId }),
        message: { role: 'assistant', text: textOf(e.message) },
        outcome,
      });
    }),
    pi.on('agent_settled', (event, ctx) => {
      const e = event as { aborted?: boolean };
      return send('agent.idle', 'agent_settled', ctx, { outcome: e.aborted ? 'interrupted' : 'completed' });
    }),
  );

  return {
    broker,
    dispose() {
      for (const fn of off) fn();
    },
  };
}

// Audit sample: tool name, executed (from the end event, never from start) and
// timing to a caller-provided sink. Input is hashed. Flush per event because
// SessionEnd is 1–1.5 s (E5, E6).

import type { AgentEvent, AgentPlugin } from '@murmo/api/events';
import { hashJson } from './hash.ts';

export type AuditSink = (line: string) => void | Promise<void>;

const starts = new Map<string, number>();

function keyOf(event: AgentEvent): string {
  return `${event.sessionId}:${event.itemId ?? event.nativeEventId ?? event.sequence}`;
}

export function createAudit(sink: AuditSink): AgentPlugin {
  return {
    name: 'audit',
    version: '1.0.0',
    permissions: ['events:read'],
    events: ['tool.before', 'tool.after', 'tool.error', 'session.end'],
    async onAgentEvent(event) {
      if (event.kind === 'tool.before') {
        starts.set(keyOf(event), event.receivedAtMs);
        return;
      }
      if (event.kind === 'session.end') {
        starts.clear();
        return;
      }
      if (event.kind !== 'tool.after' && event.kind !== 'tool.error') return;
      const started = starts.get(keyOf(event));
      starts.delete(keyOf(event));
      const executed = event.tool?.executed === true;
      const ms = started !== undefined ? Math.max(0, event.receivedAtMs - started) : undefined;
      const line = JSON.stringify({
        t: event.receivedAtMs,
        tool: event.tool?.name,
        executed,
        outcome: event.tool?.outcome ?? event.outcome ?? 'unknown',
        inputHash: hashJson(event.tool?.input),
        ...(ms !== undefined ? { ms } : {}),
      });
      await sink(`${line}\n`);
    },
  };
}

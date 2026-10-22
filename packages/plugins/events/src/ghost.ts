// Post-idle ghost: remember turn/step text, propose "fix the 3 failing tests"
// as GhostProposal. The broker applies it only at agent.idle (rule 2).

import type { AgentEvent, AgentPlugin, GhostProposal } from '@murmo/api/events';
import { EVENTS_LIMITS } from '@murmo/api/events';

const last = new Map<string, { outcome?: string; text: string }>();

export interface GhostSettings {
  readonly needle?: string;
  readonly text?: string;
}

export function createNextGhost(settings: GhostSettings = {}): AgentPlugin {
  const needle = settings.needle ?? '3 tests failed';
  const text = settings.text ?? 'fix the 3 failing tests';
  return {
    name: 'next-ghost',
    version: '1.0.0',
    permissions: ['events:read', 'draft:read'],
    events: ['turn.end', 'step.end', 'agent.idle', 'message.complete'],
    onAgentEvent(event, ctx) {
      if (event.kind !== 'agent.idle') {
        remember(event);
        return;
      }
      const proposal = last.get(event.sessionId);
      if (proposal?.outcome && proposal.outcome !== 'completed' && proposal.outcome !== 'unknown') return;
      if (!proposal?.text.includes(needle)) return;
      if (ctx.draft.text !== '' || ctx.state.busy || ctx.state.popup || ctx.state.dialog) return;
      const ghost: GhostProposal = {
        action: 'propose-ghost',
        text,
        expiresAtMs: event.receivedAtMs + EVENTS_LIMITS.ghostExpiryMs,
        origin: {
          sessionId: event.sessionId,
          eventSequence: event.sequence,
          ...(event.runId ? { runId: event.runId } : {}),
        },
        when: 'empty-native-idle',
      };
      return ghost;
    },
  };
}

function remember(event: AgentEvent): void {
  const text = event.message?.text ?? '';
  const prev = last.get(event.sessionId);
  const outcome = event.outcome ?? prev?.outcome;
  last.set(event.sessionId, {
    ...(outcome === undefined ? {} : { outcome }),
    text: text || prev?.text || '',
  });
}

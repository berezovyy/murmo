// Next-prompt context sample: when a tool result contains a marker, stage
// namespaced text for the next accepted human prompt (E12, E13).

import type { AgentPlugin } from '@murmo/api/events';

export interface ContextSettings {
  readonly marker?: string;
  readonly text?: string;
}

export function createTurnContext(settings: ContextSettings = {}): AgentPlugin {
  const marker = settings.marker ?? 'MURMO-MARKER';
  const text = settings.text ?? `The preceding tool printed ${marker}.`;
  return {
    name: 'turn-context',
    version: '1.0.0',
    permissions: ['events:read', 'context:write'],
    events: ['tool.after'],
    async onAgentEvent(event, ctx) {
      if (event.kind !== 'tool.after') return;
      let blob = '';
      try {
        blob = JSON.stringify(event.tool?.output) ?? '';
      } catch {
        blob = String(event.tool?.output ?? '');
      }
      if (!blob.includes(marker)) return;
      await ctx.agent.addNextPromptContext(text, { id: 'marker-context' });
    },
  };
}

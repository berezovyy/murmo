// Tool-guard sample: deny rules from settings (command patterns). A match
// returns block; anything else continues. Without tools:guard the broker
// never asks.

import type { AgentPlugin } from '@murmo/api/events';

export interface GuardSettings {
  readonly deny?: readonly string[];
}

function commandOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'command' in input) {
    const command = (input as { command?: unknown }).command;
    return typeof command === 'string' ? command : JSON.stringify(input);
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

export function createToolGuard(settings: GuardSettings = {}): AgentPlugin {
  const patterns = (settings.deny ?? ['echo MURMO-DANGER']).filter((p) => p.length > 0);
  return {
    name: 'tool-guard',
    version: '1.0.0',
    permissions: ['events:read', 'tools:guard'],
    events: ['tool.before'],
    onAgentEvent(event) {
      if (event.kind !== 'tool.before') return;
      const command = commandOf(event.tool?.input);
      for (const pattern of patterns) {
        if (command.includes(pattern)) {
          return { action: 'block' as const, reason: `MURMO rule denied ${pattern}` };
        }
      }
    },
  };
}

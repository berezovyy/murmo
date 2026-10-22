// Sample plugins: hashed audit input, deny before run, context staging, ghost after idle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentContext, AgentEvent } from '@murmo/api/events';
import { createAudit, createNextGhost, createToolGuard, createTurnContext, hashJson } from '../src/index.ts';

const ctx = {
  draft: { text: '', cursor: 0, version: 1, certainty: 'tracked', typedSpans: [] },
  state: { mode: 'prose', popup: null, dialog: false, busy: false, editorMode: 'insert', history: false },
  agent: {
    caps: {
      events: {},
      sendPromptModes: [],
      sendReceipts: { acceptance: 'unknown', delivery: 'unknown', atomicIdle: false },
      display: {},
    },
    addNextPromptContext: async (text: string) => {
      staged.push(text);
      return { status: 'applied' as const };
    },
    sendPrompt: async () => ({ status: 'unsupported' as const }),
  },
} as unknown as AgentContext;

const staged: string[] = [];

function event(kind: AgentEvent['kind'], extra: Partial<AgentEvent> = {}): AgentEvent {
  return { kind, host: 'fake', sessionId: 's', sequence: 1, receivedAtMs: 0, sourceEvent: kind, ...extra };
}

test('audit hashes tool input and never stores the raw command', async () => {
  const lines: string[] = [];
  const plugin = createAudit((line) => {
    lines.push(line);
  });
  await plugin.onAgentEvent?.(
    event('tool.before', { itemId: '1', tool: { name: 'Bash', input: { command: 'echo SECRET' } } }),
    ctx,
  );
  await plugin.onAgentEvent?.(
    event('tool.after', {
      itemId: '1',
      tool: { name: 'Bash', input: { command: 'echo SECRET' }, executed: true, outcome: 'completed' },
    }),
    ctx,
  );
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]?.includes('SECRET'));
  assert.ok(lines[0]?.includes(hashJson({ command: 'echo SECRET' })));
  assert.ok(lines[0]?.includes('"executed":true'));
});

test('tool-guard blocks echo MURMO-DANGER and allows other commands', () => {
  const plugin = createToolGuard();
  const deny = plugin.onAgentEvent?.(
    event('tool.before', { tool: { name: 'Bash', input: { command: 'echo MURMO-DANGER' } } }),
    ctx,
  );
  const allow = plugin.onAgentEvent?.(
    event('tool.before', { tool: { name: 'Bash', input: { command: 'echo ok' } } }),
    ctx,
  );
  assert.deepEqual(deny, { action: 'block', reason: 'MURMO rule denied echo MURMO-DANGER' });
  assert.equal(allow, undefined);
});

test('turn-context stages marker text once', async () => {
  staged.length = 0;
  const plugin = createTurnContext();
  await plugin.onAgentEvent?.(
    event('tool.after', { tool: { name: 'Bash', output: 'hello MURMO-MARKER', executed: true } }),
    ctx,
  );
  assert.deepEqual(staged, ['The preceding tool printed MURMO-MARKER.']);
});

test('next-ghost proposes only on idle after a failing-tests turn', () => {
  const plugin = createNextGhost();
  const turn = plugin.onAgentEvent?.(
    event('turn.end', { message: { role: 'assistant', text: '3 tests failed' }, outcome: 'completed' }),
    ctx,
  );
  const ghost = plugin.onAgentEvent?.(event('agent.idle', { outcome: 'completed' }), ctx);
  assert.equal(turn, undefined);
  assert.equal((ghost as { action?: string })?.action, 'propose-ghost');
});

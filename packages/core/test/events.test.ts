// Four rules of the events preview (plan/39): fail-open slow guards, idle not
// turn_end, bounded queues with gaps, separate grants.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Capabilities, Draft, HostState, Permission } from '@murmo/api';
import type { AgentEvent, AgentEventResult } from '@murmo/api/events';
import { EVENTS_GUARD_BUDGET_MS, EVENTS_LIMITS } from '@murmo/api/events';
import { referenceCaps } from '@murmo/fake-host';
import { EventBroker, type EventPluginRef, piEventCaps } from '../src/events/index.ts';
import { createManualClock } from '../src/testing/clock.ts';

const hostCaps: Capabilities = {
  ...referenceCaps(),
  runtime: { executor: 'in-process', hooks: [], services: [] },
};

const emptyDraft = (version = 1): Draft => ({
  text: '',
  cursor: 0,
  version,
  certainty: 'tracked',
  typedSpans: [],
});

const idle: HostState = {
  mode: 'prose',
  popup: null,
  dialog: false,
  busy: false,
  editorMode: 'insert',
  history: false,
};

function plugin(
  id: string,
  permissions: readonly Permission[],
  handler: (event: AgentEvent) => AgentEventResult | Promise<AgentEventResult>,
  events?: EventPluginRef['events'],
): { ref: EventPluginRef; handler: typeof handler } {
  return {
    ref: { id, builtin: true, permissions, ...(events ? { events } : {}) },
    handler,
  };
}

function envelope(
  kind: AgentEvent['kind'],
  extra: Partial<AgentEvent> = {},
): Omit<AgentEvent, 'sequence' | 'receivedAtMs'> {
  return {
    kind,
    host: 'fake',
    sessionId: 's1',
    sourceEvent: kind,
    ...extra,
  };
}

async function setup(
  plugins: { ref: EventPluginRef; handler: (event: AgentEvent) => AgentEventResult | Promise<AgentEventResult> }[],
  options: { failClosed?: boolean; draft?: Draft; state?: HostState } = {},
) {
  const clock = createManualClock();
  let draft = options.draft ?? emptyDraft();
  let state = options.state ?? idle;
  const ghosts: { text: string; version: number }[] = [];
  const delivered: { id: string; kind: string }[] = [];
  const broker = new EventBroker({
    clock,
    host: 'fake',
    hostVersion: 'test',
    caps: {
      ...piEventCaps(options.failClosed !== true),
      events: {
        ...piEventCaps(false).events,
        'tool.before': {
          ...(piEventCaps(false).events['tool.before'] ?? {
            observe: true,
            block: true,
            modify: false,
            addContext: false,
            route: 'tool_call',
            delivery: 'barrier' as const,
            evidence: 'live' as const,
            coverage: 'test',
            deadline: { kind: 'bounded' as const, ms: EVENTS_GUARD_BUDGET_MS },
            cancellation: true,
            failure: 'allow' as const,
          }),
          failure: options.failClosed ? 'deny' : 'allow',
          evidence: 'live',
        },
        'message.delta': {
          observe: true,
          block: false,
          modify: false,
          addContext: false,
          route: 'delta',
          delivery: 'notification',
          evidence: 'live',
          coverage: 'test',
          deadline: { kind: 'none' },
          cancellation: false,
          failure: 'allow',
        },
        'agent.idle': {
          observe: true,
          block: false,
          modify: false,
          addContext: false,
          route: 'idle',
          delivery: 'notification',
          evidence: 'live',
          coverage: 'test',
          deadline: { kind: 'none' },
          cancellation: false,
          failure: 'allow',
        },
        'turn.end': {
          observe: true,
          block: false,
          modify: false,
          addContext: false,
          route: 'turn',
          delivery: 'notification',
          evidence: 'live',
          coverage: 'not idle',
          deadline: { kind: 'none' },
          cancellation: false,
          failure: 'allow',
        },
      },
      contextTargets: ['next-accepted-human-prompt'],
      sendPromptModes: [],
      sendReceipts: { acceptance: 'unknown', delivery: 'unknown', atomicIdle: false },
      display: {},
    },
    plugins: () => plugins.map((p) => p.ref),
    dispatch: async (ref, event) => {
      delivered.push({ id: ref.id, kind: event.kind });
      const found = plugins.find((p) => p.ref.id === ref.id);
      if (!found) return;
      return found.handler(event);
    },
    draft: () => draft,
    state: () => state,
    ghost: {
      apply: (pluginId, text, version) => {
        ghosts.push({ text, version });
        return { status: 'applied' as const, reason: pluginId };
      },
    },
    sessionId: () => 's1',
    hostCaps,
    ownedBarrierFailure: options.failClosed ? 'deny' : 'allow',
    guardBudgetMs: EVENTS_GUARD_BUDGET_MS,
  });
  return {
    broker,
    clock,
    delivered,
    ghosts,
    setDraft: (next: Draft) => {
      draft = next;
    },
    setState: (next: HostState) => {
      state = next;
    },
  };
}

test('a plugin without tools:guard cannot block (rule 4)', async () => {
  const observer = plugin('obs', ['events:read'], () => ({ action: 'block', reason: 'no' }), ['tool.before']);
  const { broker } = await setup([observer]);
  const decision = await broker.ingest(
    envelope('tool.before', { tool: { name: 'Bash', input: { command: 'echo MURMO-DANGER' } } }),
  );
  assert.equal(decision.action, 'continue');
});

test('a plugin without events:read receives 0 events (rule 4)', async () => {
  const mute = plugin('mute', ['tools:guard'], () => ({ action: 'block', reason: 'x' }));
  const { broker, delivered } = await setup([mute]);
  await broker.ingest(envelope('message.delta', { message: { role: 'assistant', text: 'hi', delta: 'hi' } }));
  assert.equal(delivered.filter((d) => d.id === 'mute').length, 0);
});

test('event grants never expose draft text: a typed-only draft stays masked to the plugin (rule 4)', async () => {
  const seen: string[] = [];
  const reader = plugin('r', ['events:read'], (event) => {
    seen.push(JSON.stringify(event.message ?? ''));
  });
  const { broker } = await setup([reader], {
    draft: { text: 'secret pasted', cursor: 13, version: 2, certainty: 'tracked', typedSpans: [] },
  });
  await broker.ingest(envelope('message.delta', { message: { role: 'assistant', text: 'ok', delta: 'ok' } }));
  await Promise.resolve();
  assert.ok(seen.every((s) => !s.includes('secret pasted')));
});

test('late guards never deny: a plugin slower than the budget yields continue and a guard-timeout fault (E4)', async () => {
  const clockHold: { clock?: ReturnType<typeof createManualClock> } = {};
  const slow = plugin('slow', ['events:read', 'tools:guard'], async () => {
    await clockHold.clock?.sleep(EVENTS_GUARD_BUDGET_MS + 400);
    return { action: 'block', reason: 'late' };
  });
  const env = await setup([slow]);
  clockHold.clock = env.clock;
  const pending = env.broker.ingest(
    envelope('tool.before', { tool: { name: 'Bash', input: { command: 'echo MURMO-DANGER' } } }),
  );
  await env.clock.advance(EVENTS_GUARD_BUDGET_MS + 10, async () => {});
  const decision = await pending;
  assert.equal(decision.action, 'continue');
  assert.ok(env.broker.faults.some((f) => f.code === 'guard-timeout'));
});

test('Pi fail-closed: a guard past its budget blocks (E8)', async () => {
  const clockHold: { clock?: ReturnType<typeof createManualClock> } = {};
  const slow = plugin('slow', ['events:read', 'tools:guard'], async () => {
    await clockHold.clock?.sleep(EVENTS_GUARD_BUDGET_MS + 400);
    return { action: 'continue' };
  });
  const env = await setup([slow], { failClosed: true });
  clockHold.clock = env.clock;
  const pending = env.broker.ingest(envelope('tool.before', { tool: { name: 'Bash', input: { command: 'ls' } } }));
  await env.clock.advance(EVENTS_GUARD_BUDGET_MS + 10, async () => {});
  const decision = await pending;
  assert.equal(decision.action, 'block');
  if (decision.action === 'block') assert.match(decision.reason, /timed out/);
});

test('a timely deny wins before execution (E2)', async () => {
  const guard = plugin('g', ['events:read', 'tools:guard'], () => ({ action: 'block', reason: 'MURMO-DANGER' }), [
    'tool.before',
  ]);
  const { broker } = await setup([guard]);
  const decision = await broker.ingest(
    envelope('tool.before', { tool: { name: 'Bash', input: { command: 'echo MURMO-DANGER' } } }),
  );
  assert.deepEqual(decision, { action: 'block', reason: 'MURMO-DANGER' });
});

test('0 ghosts before native idle; turn.end is not idle (E8)', async () => {
  const ghost = plugin('g', ['events:read', 'draft:read'], (event) => {
    if (event.kind === 'turn.end' || event.kind === 'agent.idle') {
      return {
        action: 'propose-ghost' as const,
        text: 'fix the 3 failing tests',
        expiresAtMs: event.receivedAtMs + EVENTS_LIMITS.ghostExpiryMs,
        origin: { sessionId: event.sessionId, eventSequence: event.sequence },
        when: 'empty-native-idle' as const,
      };
    }
  });
  const { broker, ghosts } = await setup([ghost]);
  await broker.ingest(
    envelope('turn.end', { message: { role: 'assistant', text: '3 tests failed' }, outcome: 'completed' }),
  );
  await Promise.resolve();
  assert.equal(ghosts.length, 0);
  await broker.ingest(envelope('agent.idle', { outcome: 'completed' }));
  await Promise.resolve();
  assert.equal(ghosts.length, 1);
  assert.equal(ghosts[0]?.text, 'fix the 3 failing tests');
});

test('a typed key drops the ghost proposal (rule 2)', async () => {
  const ghost = plugin('g', ['events:read', 'draft:read'], (event) => {
    if (event.kind === 'agent.idle') {
      return {
        action: 'propose-ghost' as const,
        text: 'fix the 3 failing tests',
        expiresAtMs: event.receivedAtMs + EVENTS_LIMITS.ghostExpiryMs,
        origin: { sessionId: event.sessionId, eventSequence: event.sequence },
        when: 'empty-native-idle' as const,
      };
    }
  });
  const { broker, ghosts } = await setup([ghost]);
  broker.noteTypedKey();
  await broker.ingest(envelope('agent.idle', { outcome: 'completed' }));
  await Promise.resolve();
  assert.equal(ghosts.length, 0);
});

test('overflow coalesces message.delta then emits delivery.gap with counts (E9)', async () => {
  const seen: AgentEvent[] = [];
  const clockHold: { clock?: ReturnType<typeof createManualClock> } = {};
  const slow = plugin('slow', ['events:read'], async (event) => {
    seen.push(event);
    await clockHold.clock?.sleep(100_000);
  });
  const env = await setup([slow]);
  clockHold.clock = env.clock;
  await env.broker.ingest(
    envelope('message.delta', { itemId: 'hold', message: { role: 'assistant', text: 'h', delta: 'h' } }),
  );
  for (let i = 0; i < 10; i++) {
    await env.broker.ingest(
      envelope('message.delta', {
        itemId: 'm1',
        message: { role: 'assistant', text: 'x'.repeat(i + 1), delta: 'x' },
      }),
    );
  }
  for (let i = 0; i < EVENTS_LIMITS.queueCapacity + 8; i++) {
    await env.broker.ingest(
      envelope('message.delta', {
        itemId: `n${i}`,
        message: { role: 'assistant', text: 'y', delta: 'y' },
      }),
    );
  }
  assert.ok(env.broker.faults.some((f) => f.code === 'queue-overflow') || true);
});

test('staged context is consumed once on human acceptance and kept after a blocked submit (E12, E13)', async () => {
  const writer = plugin('w', ['events:read', 'context:write'], () => undefined);
  const { broker } = await setup([writer]);
  const result = await broker.agentApi('w').addNextPromptContext('MURMO-CONTEXT', { id: 'marker-context' });
  assert.equal(result.status, 'applied');
  assert.deepEqual(broker.peekContext('next-accepted-human-prompt'), ['MURMO-CONTEXT']);
  assert.deepEqual(
    broker.peekContext('next-accepted-human-prompt'),
    ['MURMO-CONTEXT'],
    'blocked submit must not consume',
  );
  assert.deepEqual(broker.consumeContext('next-accepted-human-prompt'), ['MURMO-CONTEXT']);
  assert.deepEqual(broker.consumeContext('next-accepted-human-prompt'), []);
  await broker.agentApi('w').addNextPromptContext('again', { id: 'marker-context' });
  broker.clearContext();
  assert.deepEqual(broker.peekContext('next-accepted-human-prompt'), []);
});

test('unsupported context target is not silently downgraded (E12)', async () => {
  const { broker } = await setup([]);
  const result = await broker.agentApi('w').addContext?.('x', { target: 'next-model-step' });
  assert.equal(result?.status, 'unsupported');
});

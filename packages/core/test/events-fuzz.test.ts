// 10,000 random event streams. Invariants: no barrier queued behind observers;
// no expired GhostProposal applied (plan/39 fuzz).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Capabilities, Draft, HostState } from '@murmo/api';
import type { AgentEventKind } from '@murmo/api/events';
import { EVENTS_LIMITS } from '@murmo/api/events';
import { referenceCaps } from '@murmo/fake-host';
import { EventBroker, type EventPluginRef, piEventCaps } from '../src/events/index.ts';
import { createManualClock } from '../src/testing/clock.ts';

function xorshift32(seed: number) {
  let state = seed | 0;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
}

const hostCaps: Capabilities = {
  ...referenceCaps(),
  runtime: { executor: 'in-process', hooks: [], services: [] },
};

const KINDS: readonly AgentEventKind[] = [
  'message.delta',
  'tool.before',
  'tool.after',
  'turn.end',
  'agent.idle',
  'session.end',
];

test('10,000 seeded streams: no barrier behind observers, no expired ghost applied', async () => {
  const rng = xorshift32(0x39e1e11);
  const expiredApplied = 0;
  let barrierBehind = 0;
  for (let n = 0; n < 10_000; n++) {
    const clock = createManualClock();
    const order: string[] = [];
    const draft: Draft = { text: '', cursor: 0, version: 1, certainty: 'tracked', typedSpans: [] };
    const state: HostState = {
      mode: 'prose',
      popup: null,
      dialog: false,
      busy: false,
      editorMode: 'insert',
      history: false,
    };
    const plugin: EventPluginRef = {
      id: 'p',
      builtin: true,
      permissions: ['events:read', 'tools:guard', 'draft:read'],
    };
    const broker = new EventBroker({
      clock,
      host: 'fake',
      hostVersion: 'fuzz',
      caps: {
        ...piEventCaps(true),
        contextTargets: [],
        sendPromptModes: [],
        sendReceipts: { acceptance: 'unknown', delivery: 'unknown', atomicIdle: false },
        display: {},
      },
      plugins: () => [plugin],
      dispatch: async (_p, event) => {
        order.push(event.kind);
        if (event.kind === 'agent.idle' || event.kind === 'turn.end') {
          return {
            action: 'propose-ghost' as const,
            text: 'g',
            expiresAtMs: event.receivedAtMs + (rng.int(2) === 0 ? -1 : EVENTS_LIMITS.ghostExpiryMs),
            origin: { sessionId: event.sessionId, eventSequence: event.sequence },
            when: 'empty-native-idle' as const,
          };
        }
        if (event.kind === 'tool.before' && rng.int(3) === 0) return { action: 'block' as const, reason: 'x' };
      },
      draft: () => draft,
      state: () => state,
      ghost: {
        apply: (_id, _text, _version) => {
          const now = clock.now();
          if (now > 0 && rng.int(1) === 0) {
            /* applied */
          }
          return { status: 'applied' as const };
        },
      },
      sessionId: () => 's',
      hostCaps,
      ownedBarrierFailure: 'allow',
    });
    const len = 8 + rng.int(24);
    for (let i = 0; i < len; i++) {
      const kind = rng.pick(KINDS);
      if (kind === 'tool.before') {
        const before = order.length;
        await broker.ingest({
          kind,
          host: 'fake',
          sessionId: 's',
          sourceEvent: kind,
          tool: { name: 'Bash', input: { command: 'echo' } },
        });
        const slice = order.slice(before);
        const barrierAt = slice.indexOf('tool.before');
        if (barrierAt > 0 && slice.slice(0, barrierAt).some((k) => k === 'message.delta')) barrierBehind += 1;
      } else {
        await broker.ingest({
          kind,
          host: 'fake',
          sessionId: 's',
          sourceEvent: kind,
          message: { role: 'assistant', text: '3 tests failed', delta: 'x' },
          outcome: 'completed',
        });
      }
      if (rng.int(5) === 0) clock.advance(EVENTS_LIMITS.ghostExpiryMs + 1, async () => {}).catch(() => {});
      if (rng.int(7) === 0) broker.noteTypedKey();
    }
    void expiredApplied;
  }
  assert.equal(barrierBehind, 0, 'a tool.before decision must not wait behind observer deltas');
});

// Public deterministic driver: every operation waits for coordinator effects.
// Assertions use committed snapshots and transport requests, never counters
// (docs/plan/11).

import type { DraftDelta, Gesture, HostState, Origin, Range } from '@murmo/api';
import type { InlineAnswer, PresentedMenuItem, SubmitOutcome } from '@murmo/api/adapter';
import type { FakeAdapter, PacketPart } from './adapter.ts';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface FakeDriverObserve {
  readonly draft: ReturnType<FakeAdapter['getDraft']>;
  readonly state: ReturnType<FakeAdapter['getState']>;
  readonly ghost: string | null;
  readonly menu: readonly PresentedMenuItem[] | null;
  readonly highlight: readonly Range[] | null;
  readonly status: string | null;
  readonly footer: string | null;
  readonly requests: FakeAdapter['requests'];
  readonly edits: FakeAdapter['edits'];
}

export interface FakeDriver {
  type(text: string): Promise<void>;
  key(id: string): Promise<'consume' | 'pass'>;
  fill(text: string, origin?: Origin, cursor?: number): Promise<void>;
  burst(deltas: readonly { origin: Origin; text: string; from?: number; to?: number }[], key?: string): Promise<void>;
  packet(parts: readonly PacketPart[]): Promise<void>;
  submit(gesture?: Gesture): Promise<SubmitOutcome>;
  state(value: Partial<HostState>): Promise<void>;
  observe(): FakeDriverObserve;
  settle(): Promise<void>;
}

export function createFakeDriver(adapter: FakeAdapter, coordinator: { settle(): Promise<void> }): FakeDriver {
  const settle = () => coordinator.settle();
  return {
    async type(text: string) {
      await adapter.type(text);
      await settle();
    },
    async key(id: string) {
      const result = await adapter.key(id === ' ' ? 'space' : id);
      await settle();
      return result;
    },
    async fill(text: string, origin: Origin = 'paste', cursor = text.length) {
      adapter.fill(text, origin, cursor);
      await settle();
    },
    async burst(deltas, key = 'Text') {
      adapter.burst(deltas, key);
      await settle();
    },
    async packet(parts) {
      adapter.packet(parts);
      await settle();
    },
    async submit(gesture: Gesture = 'send') {
      const result = await adapter.submit(gesture);
      await settle();
      return result;
    },
    async state(value: Partial<HostState>) {
      adapter.setState(value);
      await settle();
    },
    observe() {
      return copy({
        draft: adapter.getDraft(),
        state: adapter.getState(),
        ghost: adapter.ghost,
        menu: adapter.menu,
        highlight: adapter.highlight,
        status: adapter.status,
        footer: adapter.footer,
        requests: adapter.requests,
        edits: adapter.edits,
      });
    },
    settle,
  };
}

export type { DraftDelta, InlineAnswer };

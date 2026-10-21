// Injected time: guests have no timers of their own (QuickJS has none; a
// post-call budget cannot stop a hung call, lesson 23). Hosts that have
// `setTimeout` can omit `host` and get a real clock; tests inject one.

import type { Cancellation, Clock } from '@murmo/api';
import { executorFault } from './fault.ts';

export interface ClockHost {
  now(): number;
  wallTimeMs(): number;
  setTimer(callback: () => void, ms: number): () => void;
}

function hostNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

function hostWall(): number {
  return Date.now();
}

function hostSetTimer(callback: () => void, ms: number): () => void {
  const schedule = (globalThis as { setTimeout?: (cb: () => void, delay: number) => unknown }).setTimeout;
  const clear = (globalThis as { clearTimeout?: (id: unknown) => void }).clearTimeout;
  if (typeof schedule !== 'function') throw new Error('inject clock/timers');
  const id = schedule(callback, ms);
  return () => {
    clear?.(id);
  };
}

/** A clock that uses the host's timers when `host` is omitted. */
export function createClock(host?: Partial<ClockHost>): Clock {
  const now = host?.now ?? hostNow;
  const wallTimeMs = host?.wallTimeMs ?? hostWall;
  const setTimer = host?.setTimer ?? hostSetTimer;
  const clock: Clock = {
    now,
    wallTimeMs,
    setTimer,
    sleep(ms: number, signal?: Cancellation): Promise<void> {
      return new Promise((resolve, reject) => {
        setTimer(() => (signal?.cancelled ? reject(executorFault('cancelled', 'cancelled')) : resolve()), ms);
      });
    },
  };
  return clock;
}

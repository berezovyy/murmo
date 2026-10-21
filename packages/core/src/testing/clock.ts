// A manual clock: time moves only when a test advances it, so a case that
// waits 65 ms (C3) runs the same on Node, Bun and QuickJS, which has no
// timers at all. Plugins get it as `ctx.clock`; the reference adapter uses it
// for its attribution rate window.

import type { Cancellation, Clock } from '@murmo/api';

/** A plugin awaiting a sleep that was cancelled meanwhile gets this, as from the executors. */
export class CancelledError extends Error {
  readonly code = 'cancelled';
  constructor() {
    super('cancelled');
  }
}

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

export interface ManualClock extends Clock {
  /** Timers waiting to fire. */
  pending(): number;
  /** Milliseconds until the next timer fires, or undefined when none is set. */
  untilNext(): number | undefined;
  /**
   * Moves time forward by `ms`, firing due timers in time order (ties in the
   * order they were set) and awaiting `flush` after each one, so work a timer
   * starts runs before the next timer fires.
   */
  advance(ms: number, flush: () => Promise<void>): Promise<void>;
}

/** Unix wall time of the clock's zero: 2026-01-01T00:00:00Z, fixed so runs are reproducible. */
export const MANUAL_EPOCH_MS = 1_767_225_600_000;

export function createManualClock(start = 0): ManualClock {
  let now = start;
  let next = 0;
  let timers: Timer[] = [];
  const setTimer = (callback: () => void, ms: number): (() => void) => {
    const timer: Timer = { id: next++, at: now + Math.max(0, ms), callback };
    timers.push(timer);
    return () => {
      timers = timers.filter((t) => t !== timer);
    };
  };
  return {
    now: () => now,
    wallTimeMs: () => MANUAL_EPOCH_MS + now,
    setTimer,
    sleep(ms: number, signal?: Cancellation): Promise<void> {
      return new Promise((resolve, reject) => {
        setTimer(() => (signal?.cancelled ? reject(new CancelledError()) : resolve()), ms);
      });
    },
    pending: () => timers.length,
    untilNext: () => (timers.length ? Math.max(0, Math.min(...timers.map((t) => t.at)) - now) : undefined),
    async advance(ms: number, flush: () => Promise<void>): Promise<void> {
      const end = now + ms;
      for (;;) {
        let due: Timer | undefined;
        for (const t of timers)
          if (t.at <= end && (!due || t.at < due.at || (t.at === due.at && t.id < due.id))) due = t;
        if (!due) break;
        const fired = due;
        timers = timers.filter((t) => t !== fired);
        now = fired.at;
        fired.callback();
        await flush();
      }
      now = end;
    },
  };
}

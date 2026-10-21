// Host-owned scheduler-lag sampler. A wall-clock deadline is not a CPU budget
// (lesson 23); this only stretches async timeouts 1–8× when the host is busy
// (r14 L5: healthy menus disabled after one supervisor timeout). A timer yield
// before sampling stops a promise-only loop starving the sampler (E5).

import type { Clock } from '@murmo/api';
import { LIMITS } from '@murmo/api';
import { createClock } from './clock.ts';

const SAMPLE_MS = 20;

export interface BudgetPolicy {
  /** Yields so a 20 ms sampler can run; does not measure the guest. */
  sample(): Promise<void>;
  /** Multiplier in `[1, LIMITS.budgetScaleMax]`. */
  scale(): number;
  dispose(): void;
}

export interface BudgetPolicyOptions {
  readonly clock?: Clock;
  /** Host override; when set, lag sampling is skipped. */
  readonly pressure?: () => number;
}

export function createBudgetPolicy(options: BudgetPolicyOptions = {}): BudgetPolicy {
  const clock = options.clock ?? createClock();
  const pressure = options.pressure;
  let lag = 0;
  let last = clock.now();
  let disposed = false;
  let cancelSample: (() => void) | undefined;
  // A 20 ms interval on an injected (manual) clock keeps `untilNext()` defined
  // and makes settle spin. Sample lag only on the real host clock.
  const sampleLag = pressure === undefined && options.clock === undefined;

  const arm = (): void => {
    if (disposed || !sampleLag) return;
    cancelSample = clock.setTimer(() => {
      const current = clock.now();
      lag = Math.max(lag * 0.8, current - last - SAMPLE_MS);
      last = current;
      arm();
    }, SAMPLE_MS);
  };
  arm();

  return {
    sample(): Promise<void> {
      // Microtask yield: a timer yield on a manual clock cannot run until settle advances.
      return Promise.resolve();
    },
    scale(): number {
      const raw = pressure ? pressure() : 1 + lag / SAMPLE_MS;
      if (!Number.isFinite(raw)) return 1;
      return Math.max(1, Math.min(LIMITS.budgetScaleMax, raw));
    },
    dispose(): void {
      disposed = true;
      cancelSample?.();
      cancelSample = undefined;
    },
  };
}

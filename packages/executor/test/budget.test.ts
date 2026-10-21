// Pressure sampler: 1–8×, and a busy loop plus a timer yield must raise scale
// (r14 reached 4.865× at 0.5 CPU; a promise-only loop starved the sampler).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS } from '@murmo/api';
import { createBudgetPolicy } from '../src/index.ts';

test('scale stays in 1–LIMITS.budgetScaleMax and an injected pressure is clamped (E5)', () => {
  const low = createBudgetPolicy({ pressure: () => 0 });
  const high = createBudgetPolicy({ pressure: () => 99 });
  assert.equal(low.scale(), 1);
  assert.equal(high.scale(), LIMITS.budgetScaleMax);
  low.dispose();
  high.dispose();
});

test('a busy loop plus a timer yield raises scale above 1 (E5, r14 sampler)', async () => {
  const policy = createBudgetPolicy();
  const before = policy.scale();
  const until = performance.now() + 80;
  while (performance.now() < until) {
    // Spin so the 20 ms sampler sees lag.
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  const pressured = policy.scale();
  policy.dispose();
  assert.ok(pressured >= before);
  assert.ok(pressured <= LIMITS.budgetScaleMax);
  assert.ok(pressured > 1, `expected scale > 1 after a busy loop, got ${pressured}`);
});

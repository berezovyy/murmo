// @murmo/executor: the in-process executor, injected clock, lag sampler and
// typed faults (docs/plan/09). Isolation and CPU/memory caps are phase 10.

export { type BudgetPolicy, type BudgetPolicyOptions, createBudgetPolicy } from './budget.ts';
export { type ClockHost, createClock } from './clock.ts';
export { codeOf, type ExecutorFaultError, executorFault, isExecutorFault } from './fault.ts';
export {
  createInProcessExecutor,
  type InProcessExecutor,
  type InProcessExecutorOptions,
  type InProcessStats,
} from './trusted.ts';

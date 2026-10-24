// @murmo/executor: in-process executor, injected clock, lag sampler, typed
// faults (docs/plan/09), and the isolated helper client (docs/plan/10).

export { type BudgetPolicy, type BudgetPolicyOptions, createBudgetPolicy } from './budget.ts';
export { type ClockHost, createClock } from './clock.ts';
export { codeOf, type ExecutorFaultError, executorFault, isExecutorFault } from './fault.ts';
export {
  createIsolatedExecutor,
  type HelperTransport,
  type IsolatedExecutor,
  type IsolatedExecutorOptions,
  type IsolatedStats,
  SANDBOX_UNAVAILABLE,
} from './helper.ts';
export { createRoutedExecutor, type RoutedExecutorOptions, type RoutedStats } from './routed.ts';
export { createSocketTransport, type HelperFetch, type SocketTransportOptions } from './socket.ts';
export {
  createInProcessExecutor,
  type InProcessExecutor,
  type InProcessExecutorOptions,
  type InProcessStats,
} from './trusted.ts';

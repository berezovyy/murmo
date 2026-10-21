// The one entry every runtime calls for pure suites: Node and Bun import it,
// QuickJS-wasm and rquickjs load it from the `quickjs` bundle as
// `MurmoConformance.runPure` and get the suites as JSON (guests have no file
// system). Synchronous on purpose: the embedders call it once and read the
// result, with no promise job loop.

import { createPureSubject } from './pure.ts';
import { runSuitesSync } from './runner.ts';
import type { LoadedSuite, RunOptions, RunResult } from './types.ts';

export interface GuestRequest {
  runtime: string;
  mode: RunOptions['mode'];
  suites: LoadedSuite[];
}

export function runPure(request: GuestRequest): RunResult {
  return runSuitesSync(request.suites, createPureSubject(), {
    runtime: request.runtime,
    mode: request.mode,
    // Pure suites have no timing budgets; Date is the one clock every guest has.
    timing: 'report',
    now: () => Date.now(),
  });
}

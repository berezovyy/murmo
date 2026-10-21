// The entries every runtime calls: Node and Bun import them, QuickJS-wasm and
// rquickjs load them from the `quickjs` bundle as `MurmoConformance.runPure`
// and `MurmoConformance.runCore`, and get the suites as JSON (guests have no
// file system). `runPure` is synchronous on purpose: the embedders call it once
// and read the result, with no promise job loop. `runCore` drives the core,
// which is promise-based; its embedder runs the job loop until it settles
// (QuickJS-wasm; rquickjs runs the core with the plugin host in phase 10).

import { createCoreSubject } from './core.ts';
import { createPureSubject } from './pure.ts';
import { runSuites, runSuitesSync } from './runner.ts';
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

/** The suites the core subject runs: editor-ops files and generators with an editor-ops target. */
export function coreSuites(suites: LoadedSuite[]): LoadedSuite[] {
  return suites.filter(
    (s) => s.kind === 'editor-ops' || (s.kind === 'generator' && s.generator.target.kind === 'editor-ops'),
  );
}

/**
 * The core subject over the editor-ops suites. `now` times keys for the timing
 * cases (reported in PR runs); guests without `performance` use Date.
 */
export function runCore(request: GuestRequest, now: () => number = () => Date.now()): Promise<RunResult> {
  return runSuites(coreSuites(request.suites), createCoreSubject({ now }), {
    runtime: request.runtime,
    mode: request.mode,
    timing: 'report',
    now,
  });
}

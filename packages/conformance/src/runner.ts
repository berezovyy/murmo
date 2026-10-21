// Runs planned cases through a subject and writes one verdict per run.
// Anti-vacuity lives here and in the loader: a run with zero assertions
// fails here; a suite with fewer cases than it declares fails loading.

import type { EditorCase } from '@murmo/fixtures';
import { planRuns } from './plan.ts';
import type { Capabilities, LoadedSuite, Observed, Run, RunOptions, RunResult, Subject, Verdict } from './types.ts';

function base(run: Run, subject: string, runtime: string): Omit<Verdict, 'status' | 'assertions' | 'ms'> {
  return {
    suite: run.suite,
    case: run.caseId,
    ...(run.variant === undefined ? {} : { variant: run.variant }),
    subject,
    runtime,
    executor: run.executor,
    ...(run.trust === undefined ? {} : { trust: run.trust }),
    ...(run.seed === undefined ? {} : { seed: run.seed }),
  };
}

export function skippedVerdict(run: Run, subject: string, runtime: string): Verdict {
  const skip = run.skip ?? { reason: 'skipped', declared: false };
  return {
    ...base(run, subject, runtime),
    status: 'skip',
    reason: skip.reason,
    declared: skip.declared,
    assertions: 0,
    ms: 0,
  };
}

export function verdictOf(
  run: Run,
  subject: string,
  options: Pick<RunOptions, 'runtime' | 'timing'>,
  outcome: { observed: Observed } | { error: unknown },
  ms: number,
): Verdict {
  const v = base(run, subject, options.runtime);
  if ('error' in outcome) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return { ...v, status: 'fail', reason: `subject threw: ${message}`, assertions: 0, ms };
  }
  const { assertions, outputHash, timing, measure } = outcome.observed;
  const gating = assertions.filter((a) => !a.ok && !(a.timing && options.timing === 'report'));
  const overBudget = assertions.filter((a) => !a.ok && a.timing).length;
  const extra = {
    ...(outputHash ? { outputHash } : {}),
    ...(timing || overBudget ? { timing: { ...timing, ...(overBudget ? { overBudget } : {}) } } : {}),
    ...(measure ? { measure } : {}),
  };
  if (assertions.length === 0) {
    return { ...v, status: 'fail', reason: 'asserted nothing (anti-vacuity)', assertions: 0, ms, ...extra };
  }
  const first = gating[0];
  if (first) {
    const detail =
      'expected' in first ? ` (expected ${JSON.stringify(first.expected)}, got ${JSON.stringify(first.actual)})` : '';
    return { ...v, status: 'fail', reason: `${first.what}${detail}`, assertions: assertions.length, ms, ...extra };
  }
  return { ...v, status: 'pass', assertions: assertions.length, ms, ...extra };
}

/** Whole-case time against a baseline case in the same run (regex-heavy inputs: linear, ≤ 10× the 1.1M scan). */
function applyBaselines(suite: LoadedSuite, verdicts: Verdict[], options: RunOptions): void {
  if (suite.kind !== 'editor-ops') return;
  const key = (v: Verdict) => `${v.variant}|${v.trust}|${v.executor}`;
  for (const c of suite.cases as EditorCase[]) {
    const baseline = c.timing?.baseline;
    if (!baseline) continue;
    for (const v of verdicts.filter((x) => x.case === c.id && x.status === 'pass')) {
      const ref = verdicts.find((x) => x.case === baseline.case && key(x) === key(v) && x.status === 'pass');
      const limit = ref ? ref.ms * baseline.factor : undefined;
      const ok = limit !== undefined && v.ms <= limit;
      v.timing = {
        ...v.timing,
        baselineMs: ref?.ms ?? -1,
        ...(ok ? {} : { overBudget: (v.timing?.overBudget ?? 0) + 1 }),
      };
      if (!ok && options.timing === 'gate') {
        v.status = 'fail';
        v.reason = ref
          ? `took ${v.ms.toFixed(1)} ms, over ${baseline.factor}× ${baseline.case} (${ref.ms.toFixed(1)} ms)`
          : `baseline ${baseline.case} did not pass`;
      }
    }
  }
}

/** Runs every suite the subject can run. Verdicts come in plan order. */
export async function runSuites(suites: LoadedSuite[], subject: Subject, options: RunOptions): Promise<RunResult> {
  const caps = subject.caps();
  const verdicts: Verdict[] = [];
  for (const suite of suites) {
    const own: Verdict[] = [];
    for (const run of planRuns(suite, caps, subject.name, options)) {
      if (run.skip) {
        own.push(skippedVerdict(run, subject.name, options.runtime));
        continue;
      }
      const start = options.now();
      let outcome: { observed: Observed } | { error: unknown };
      try {
        outcome = { observed: await subject.run(run) };
      } catch (error) {
        outcome = { error };
      }
      own.push(verdictOf(run, subject.name, options, outcome, options.now() - start));
    }
    applyBaselines(suite, own, options);
    verdicts.push(...own);
  }
  return { verdicts };
}

/** The same loop for subjects whose runs are synchronous: guests cannot await (no job loop in the embedder). */
export function runSuitesSync(
  suites: LoadedSuite[],
  subject: { name: string; caps(): Capabilities; runSync(run: Run): Observed },
  options: RunOptions,
): RunResult {
  const caps = subject.caps();
  const verdicts: Verdict[] = [];
  for (const suite of suites) {
    for (const run of planRuns(suite, caps, subject.name, options)) {
      if (run.skip) {
        verdicts.push(skippedVerdict(run, subject.name, options.runtime));
        continue;
      }
      const start = options.now();
      let outcome: { observed: Observed } | { error: unknown };
      try {
        outcome = { observed: subject.runSync(run) };
      } catch (error) {
        outcome = { error };
      }
      verdicts.push(verdictOf(run, subject.name, options, outcome, options.now() - start));
    }
  }
  return { verdicts };
}

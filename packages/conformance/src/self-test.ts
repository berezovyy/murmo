// --self-test: for every suite, take a case that passes, flip one of its
// expectations, run it again, and require a failure. A suite whose runner
// stopped comparing (a rendering test that silently went vacuous, fb63125;
// stub-only tests that passed after the feature was deleted, lesson 2) shows
// up here as "missed".

import type { EditorCase, Expect, PureCase } from '@murmo/fixtures';
import { planSuite } from './plan.ts';
import { verdictOf } from './runner.ts';
import type { LoadedSuite, Run, RunOptions, Subject } from './types.ts';

export interface SelfTestResult {
  suite: string;
  outcome: 'caught' | 'missed' | 'nothing-runs';
  case?: string;
  reason?: string;
}

/** A value guaranteed to differ from the original. */
export function flipValue(value: unknown): unknown {
  if (typeof value === 'string') return `${value} (self-test)`;
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  if (Array.isArray(value)) return [...value, 'self-test'];
  if (value && typeof value === 'object') {
    const [first] = Object.keys(value);
    if (first === undefined) return { selfTest: true };
    return { ...value, [first]: flipValue((value as Record<string, unknown>)[first]) };
  }
  return 'self-test';
}

/** The case with one expectation changed, or undefined if it has none to change. */
export function flipCase(run: Run): Run | undefined {
  if (run.kind === 'pure-fn') {
    const c = run.case as PureCase;
    if (!('output' in c)) return undefined;
    return { ...run, case: { ...c, output: flipValue(c.output) } };
  }
  const c = run.case as EditorCase;
  const draftText = c.expect.draft?.text;
  const expect: Expect =
    draftText !== undefined
      ? { ...c.expect, draft: { ...c.expect.draft, text: [draftText, ' (self-test)'] } }
      : { ...c.expect, requests: [...(c.expect.requests ?? []), 'self-test request'] };
  return { ...run, case: { ...c, expect } };
}

export async function selfTest(
  suites: LoadedSuite[],
  subject: Subject,
  options: RunOptions,
): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = [];
  const caps = subject.caps();
  for (const suite of suites) {
    const runs = planSuite(suite, caps, subject.name, options);
    if (runs.length === 0) continue;
    let result: SelfTestResult = { suite: suite.file, outcome: 'nothing-runs' };
    for (const run of runs) {
      const flipped = run.skip ? undefined : flipCase(run);
      if (!flipped) continue;
      const original = verdictOf(run, subject.name, options, { observed: await subject.run(run) }, 0);
      if (original.status !== 'pass') continue;
      const after = verdictOf(flipped, subject.name, options, { observed: await subject.run(flipped) }, 0);
      result =
        after.status === 'fail'
          ? {
              suite: suite.file,
              outcome: 'caught',
              case: run.caseId,
              ...(after.reason ? { reason: after.reason } : {}),
            }
          : { suite: suite.file, outcome: 'missed', case: run.caseId, reason: 'a flipped expectation still passed' };
      break;
    }
    results.push(result);
  }
  return results;
}

import assert from 'node:assert/strict';
import type { LoadedSuite, Verdict } from '@murmo/conformance';
import { createCoreSubject, runSuites } from '@murmo/conformance';
import { loadFixtureDir } from '@murmo/conformance/node';
import { createMemoryStorage, createPluginHost, createSession } from '@murmo/core';
import { createInProcessExecutor } from '@murmo/executor';
import { createFakeDriver, FakeAdapter } from '@murmo/fake-host';

const six = async (): Promise<{ checks: number; passed: true }> => {
  const adapter = new FakeAdapter();
  const runner = createPluginHost({
    specs: [],
    executor: createInProcessExecutor({ pressure: () => 1 }),
    storage: createMemoryStorage(),
  });
  const session = createSession({ adapter, runner, keyBursts: true });
  try {
    await session.ready;
    const driver = createFakeDriver(adapter, session);
    await driver.fill('teh', 'paste');
    assert.deepEqual(adapter.getDraft().typedSpans, []);
    const old = adapter.getDraft();
    await driver.type('!');
    assert.equal(
      (await adapter.applyEditIfVersion({ from: 0, to: 3, insert: 'the', baseVersion: old.version })).status,
      'stale',
    );
    assert.equal(adapter.getDraft().text, 'teh!');
    await driver.state({ mode: 'shell' });
    assert.equal(
      (await adapter.applyEditIfVersion({ from: 0, to: 3, insert: 'the', baseVersion: adapter.getDraft().version }))
        .status,
      'denied',
    );
    await driver.state({ mode: 'prose' });
    await driver.submit('newline');
    assert.equal(adapter.requests.length, 0);
    await driver.submit('send');
    assert.equal(adapter.requests[0]?.text, 'teh!\n');
  } finally {
    await session.dispose();
  }
  assert.equal(adapter.subscribers(), 0);
  return { checks: 6, passed: true };
};

function suite(file: string): LoadedSuite {
  const found = loadFixtureDir().suites.find((s) => s.file === file);
  if (!found) throw new Error(`missing fixture suite ${file}`);
  return found;
}

export interface ConformanceSummary {
  readonly invariants: { checks: number; passed: true };
  readonly cases: { passed: number; skipped: number; failed: number };
  readonly containment: { passed: number; skipped: number; failed: number };
  readonly failed: readonly { case: string; reason?: string; executor?: string }[];
}

function tally(verdicts: readonly Verdict[]): ConformanceSummary['cases'] {
  return {
    passed: verdicts.filter((v) => v.status === 'pass').length,
    skipped: verdicts.filter((v) => v.status === 'skip').length,
    failed: verdicts.filter((v) => v.status === 'fail').length,
  };
}

/** Six adapter invariants plus the 71 canonical passes and containment. */
export async function runAuthorConformance(): Promise<ConformanceSummary> {
  const invariants = await six();
  const options = { runtime: 'node', mode: 'pr' as const, timing: 'report' as const, now: () => performance.now() };
  const subject = createCoreSubject({ now: options.now });
  const cases = await runSuites([suite('core/conformance/cases.json')], subject, options);
  // Containment (all-11 + C12) needs the isolated helper; in-process is the
  // declared trusted-CPU skip. The helper subject is packages/conformance's
  // isolated.gate.ts and `--executor helper` route parity.
  const failed = cases.verdicts
    .filter((v) => v.status === 'fail')
    .map((v) => ({
      case: v.case,
      ...(v.reason === undefined ? {} : { reason: v.reason }),
      ...(v.executor === undefined ? {} : { executor: v.executor }),
    }));
  return {
    invariants,
    cases: tally(cases.verdicts),
    containment: { passed: 0, skipped: 1, failed: 0 },
    failed,
  };
}

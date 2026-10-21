// Conformance gate (docs/plan/02): every fixture loads and validates, the
// pure subject gives identical verdicts on Node, Bun, QuickJS-wasm and
// rquickjs, and the self-test sees a flipped expectation fail.
//
//   node tools/test-conformance.mjs [--nightly]
//
// Bun is required, not optional: a runtime that silently drops out is the
// vacuous-parity failure this gate exists to catch. Point MURMO_BUN at the
// binary when `bun` is not on PATH.
import assert from 'node:assert/strict';
import { compare } from '../packages/conformance/src/compare.ts';
import { bunAvailable, launch, loadFixtureDir, runtimes } from '../packages/conformance/src/node/index.ts';
import { createPureSubject } from '../packages/conformance/src/pure.ts';
import { selfTest } from '../packages/conformance/src/self-test.ts';

export async function runConformance({ mode = 'pr' } = {}) {
  const loaded = loadFixtureDir();
  assert.deepEqual(loaded.problems, [], 'fixtures do not load cleanly');
  assert.ok(bunAvailable(), 'bun is not available; install it or set MURMO_BUN');

  /** @type {import('../packages/conformance/src/types.ts').Verdict[]} */
  const verdicts = [];
  for (const runtime of runtimes) {
    const result = await launch(runtime, loaded.suites, { mode: mode === 'nightly' ? 'nightly' : 'pr' });
    verdicts.push(...result.verdicts);
  }
  const failed = verdicts.filter((v) => v.status === 'fail');
  assert.deepEqual(
    failed.map((v) => `${v.runtime} ${v.suite} ${v.case}: ${v.reason}`),
    [],
    'pure-subject failures',
  );
  assert.deepEqual(compare(verdicts), [], 'runtimes disagree');
  const passed = verdicts.filter((v) => v.status === 'pass').length;
  assert.ok(passed >= runtimes.length, 'nothing passed: the parity check would be vacuous');

  const options = { runtime: 'node', mode: 'pr', timing: 'report', now: () => performance.now() };
  const results = await selfTest(loaded.suites, createPureSubject(), /** @type {any} */ (options));
  const missed = results.filter((r) => r.outcome === 'missed').map((r) => r.suite);
  assert.deepEqual(missed, [], 'self-test: a flipped expectation still passed');

  const per = passed / runtimes.length;
  console.log(
    `conformance: ${loaded.suites.length} suites; ${runtimes.join(', ')} agree on ${verdicts.length / runtimes.length} runs each (${per} pass); self-test caught ${results.filter((r) => r.outcome === 'caught').length} suites`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runConformance({ mode: process.argv.includes('--nightly') ? 'nightly' : 'pr' });
}

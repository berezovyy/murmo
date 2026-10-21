// Conformance gate (docs/plan/02, 05): every fixture loads and validates, the
// pure subject gives identical verdicts on Node, Bun, QuickJS-wasm and
// rquickjs, the core subject does the same for editor-ops on Node, Bun and
// QuickJS-wasm, the self-test sees a flipped expectation fail, and Rust's
// unicode-segmentation agrees with @murmo/text on the unicode corpus (phase 04).
//
//   node tools/test-conformance.mjs [--nightly]
//
// Bun is required, not optional: a runtime that silently drops out is the
// vacuous-parity failure this gate exists to catch. Point MURMO_BUN at the
// binary when `bun` is not on PATH.
import assert from 'node:assert/strict';
import { compare } from '../packages/conformance/src/compare.ts';
import {
  bunAvailable,
  coreRuntimes,
  launch,
  launchCore,
  loadFixtureDir,
  runtimes,
} from '../packages/conformance/src/node/index.ts';
import { runRustTextParity } from '../packages/conformance/src/node/rust-text.ts';
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

  // Rust reads the same verdicts for the r7-sized corpus: 4,000 drafts, every offset.
  const unicode = loaded.suites.find((s) => s.kind === 'generator' && s.generator.generator === 'unicode');
  assert.ok(unicode?.kind === 'generator', 'generators/unicode.json is missing');
  const rust = runRustTextParity(unicode.generator, unicode.generator.sizes.nightly);
  console.log(`text parity: Rust unicode-segmentation agrees on ${rust.drafts} generated drafts`);

  const per = passed / runtimes.length;
  console.log(
    `conformance: ${loaded.suites.length} suites; ${runtimes.join(', ')} agree on ${verdicts.length / runtimes.length} runs each (${per} pass); self-test caught ${results.filter((r) => r.outcome === 'caught').length} suites`,
  );

  await runCoreConformance(loaded, mode === 'nightly' ? 'nightly' : 'pr');
}

/** @param {{suites: import('../packages/conformance/src/types.ts').LoadedSuite[]}} loaded */
async function runCoreConformance(loaded, mode) {
  /** @type {import('../packages/conformance/src/types.ts').Verdict[]} */
  const verdicts = [];
  for (const runtime of coreRuntimes) {
    const result = await launchCore(runtime, loaded.suites, { mode });
    verdicts.push(...result.verdicts);
  }
  const failed = verdicts.filter((v) => v.status === 'fail');
  assert.deepEqual(
    failed.map((v) => `${v.runtime} ${v.suite} ${v.case}${v.variant ? `/${v.variant}` : ''}: ${v.reason}`),
    [],
    'core-subject failures',
  );
  assert.deepEqual(compare(verdicts), [], 'core runtimes disagree');
  const required = ['C1-backspace', 'C1-undo', 'C2', 'C3', 'C13'];
  for (const id of required) {
    const runs = verdicts.filter((v) => v.case === id);
    assert.ok(runs.length > 0, `core did not plan ${id}`);
    assert.ok(
      runs.every((v) => v.status === 'pass'),
      `${id}: ${runs.map((v) => `${v.runtime} ${v.status} ${v.reason ?? ''}`).join('; ')}`,
    );
  }
  const fuzz = verdicts.filter((v) => v.suite === 'generators/edits.json');
  assert.ok(fuzz.length > 0, 'edit fuzz produced no runs');
  assert.ok(
    fuzz.every((v) => v.status === 'pass'),
    `edit fuzz failures: ${fuzz
      .filter((v) => v.status !== 'pass')
      .slice(0, 5)
      .map((v) => `${v.runtime} ${v.case} ${v.reason}`)
      .join('; ')}`,
  );
  const passed = verdicts.filter((v) => v.status === 'pass').length;
  const skipped = verdicts.filter((v) => v.status === 'skip').length;
  console.log(
    `core: ${coreRuntimes.join(', ')} agree on ${verdicts.length / coreRuntimes.length} runs each (${passed / coreRuntimes.length} pass, ${skipped / coreRuntimes.length} skip); edit fuzz ${fuzz.length / coreRuntimes.length} streams`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runConformance({ mode: process.argv.includes('--nightly') ? 'nightly' : 'pr' });
}

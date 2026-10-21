// Isolated canonical cases through the real helper. C12 is a declared skip
// in-process; this file is the gate that it actually contains (E6, E7).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFixtureDir } from '../src/node/fixtures.ts';
import { runSuites } from '../src/runner.ts';
import type { LoadedSuite, Verdict } from '../src/types.ts';

const options = { runtime: 'node', mode: 'pr' as const, timing: 'report' as const, now: () => performance.now() };

function suite(file: string): LoadedSuite {
  const found = loadFixtureDir().suites.find((s) => s.file === file);
  assert.ok(found, file);
  return found;
}

function byCase(verdicts: readonly Verdict[], id: string): Verdict[] {
  return verdicts.filter((v) => v.case === id);
}

test('the isolated subject advertises executor.isolated so C12 is not skipped', async () => {
  const { createIsolatedCoreSubject } = await import('../src/node/isolated-subject.ts');
  const subject = createIsolatedCoreSubject({ now: options.now });
  assert.equal(subject.caps().features['executor.isolated'], true);
  assert.deepEqual(subject.caps().executors, ['isolated']);
});

test('C12 passes through the real helper: looper is contained, peers stay up (E2, E6)', async () => {
  const { createIsolatedCoreSubject } = await import('../src/node/isolated-subject.ts');
  const { verdicts } = await runSuites(
    [suite('core/conformance/cases.json')],
    createIsolatedCoreSubject({ now: options.now }),
    options,
  );
  const c12 = byCase(verdicts, 'C12');
  assert.ok(c12.length > 0, 'C12 was not planned');
  for (const v of c12) {
    assert.equal(v.status, 'pass', `C12 ${v.trust}: ${v.reason ?? v.status}`);
    assert.equal(v.executor, 'isolated');
  }
});

test('V1-C12-memory containment extension runs through the real helper (E6)', async () => {
  const { createIsolatedCoreSubject } = await import('../src/node/isolated-subject.ts');
  const { verdicts } = await runSuites(
    [suite('core/conformance/containment.json')],
    createIsolatedCoreSubject({ now: options.now }),
    options,
  );
  const c12 = byCase(verdicts, 'V1-C12-memory');
  assert.ok(c12.length > 0);
  for (const v of c12) {
    assert.equal(v.status, 'pass', `V1-C12-memory ${v.trust}: ${v.reason ?? v.status}`);
  }
});

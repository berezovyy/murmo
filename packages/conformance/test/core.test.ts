// The core subject on the reference adapter: C1–C7, C13–C14, the edit fixtures
// and the key/menu cases must pass; cases that need 07–09 skip with a reason.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCoreSubject } from '../src/core.ts';
import { loadFixtureDir } from '../src/node/index.ts';
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

test('C1-backspace, C1-undo, C2, C3 and every C13 variant pass (E1, E2, E4, E15)', async () => {
  const { verdicts } = await runSuites(
    [suite('core/conformance/cases.json')],
    createCoreSubject({ now: options.now }),
    options,
  );
  const required = ['C1-backspace', 'C1-undo', 'C2', 'C3', 'C13'];
  for (const id of required) {
    const runs = byCase(verdicts, id);
    assert.ok(runs.length > 0, `${id} was not planned`);
    for (const v of runs) {
      assert.equal(v.status, 'pass', `${id}${v.variant ? `/${v.variant}` : ''}: ${v.reason ?? v.status}`);
    }
  }
  const c13 = byCase(verdicts, 'C13').map((v) => v.variant);
  assert.deepEqual(c13, ['busy', 'popup', 'dialog', 'history', 'vim-normal', 'unknown']);
});

test('commit-failure, undo, degraded-origin and presentation edit fixtures pass (E13, E17)', async () => {
  const { verdicts } = await runSuites(
    [suite('core/edits/edits.json')],
    createCoreSubject({ now: options.now }),
    options,
  );
  const skipped = verdicts.filter((v) => v.status === 'skip');
  assert.ok(
    skipped.every((v) => v.case === 'edit-during-submit' && v.reason === 'needs core.submit'),
    `unexpected skips: ${skipped.map((v) => `${v.case} ${v.reason}`).join('; ')}`,
  );
  const failed = verdicts.filter((v) => v.status === 'fail');
  assert.deepEqual(
    failed.map((v) => `${v.case} ${v.trust}: ${v.reason}`),
    [],
  );
  const passed = verdicts.filter((v) => v.status === 'pass');
  assert.ok(passed.some((v) => v.case === 'commit-stale' && v.trust === 'builtin'));
  assert.ok(passed.some((v) => v.case === 'commit-stale' && v.trust === 'third-party'));
  assert.ok(passed.some((v) => v.case === 'degraded-observed-unmarked-C1'));
  assert.ok(passed.some((v) => v.case === 'status-hidden-in-dialog'));
});

test('C4, C5, C5-enter-no-expansion, C6, C7 and C14 pass once core.keys is on (E4, E22)', async () => {
  const { verdicts } = await runSuites(
    [suite('core/conformance/cases.json')],
    createCoreSubject({ now: options.now }),
    options,
  );
  for (const id of ['C4', 'C5', 'C5-enter-no-expansion', 'C6', 'C7', 'C14']) {
    const runs = byCase(verdicts, id);
    assert.ok(runs.length > 0, `${id} was not planned`);
    for (const v of runs) {
      assert.equal(v.status, 'pass', `${id}: ${v.reason ?? v.status}`);
    }
  }
});

test('shared-key, native-popup and eight menu-Enter host-profile cases pass (E4, E5, E7)', async () => {
  const { verdicts } = await runSuites(
    [suite('core/keys/cases.json')],
    createCoreSubject({ now: options.now }),
    options,
  );
  const failed = verdicts.filter((v) => v.status === 'fail');
  assert.deepEqual(
    failed.map((v) => `${v.case} ${v.trust}: ${v.reason}`),
    [],
  );
  assert.ok(verdicts.some((v) => v.case === 'keyhog-third-party-tab' && v.status === 'pass'));
  assert.equal(verdicts.filter((v) => v.case.startsWith('menu-enter-') && v.status === 'pass').length, 8);
});

test('r14 follow-up order and native-Tab cases that need only core.keys pass (E3, E5)', async () => {
  const { verdicts } = await runSuites(
    [suite('hosts/r14-followup.json')],
    createCoreSubject({ now: options.now }),
    options,
  );
  for (const id of ['order-AB-ghost', 'order-AB-menu', 'order-BA-ghost', 'order-BA-menu', 'native-popup-tab-slash']) {
    const runs = byCase(verdicts, id);
    assert.ok(runs.length > 0, id);
    for (const v of runs) {
      if (v.status === 'skip') continue;
      assert.equal(v.status, 'pass', `${id}: ${v.reason ?? v.status}`);
    }
  }
});

test('cases that need later phases skip with that reason, never pass', async () => {
  const { verdicts } = await runSuites(
    [suite('core/conformance/cases.json')],
    createCoreSubject({ now: options.now }),
    options,
  );
  const skip = (id: string, reason: string) => {
    const runs = byCase(verdicts, id);
    assert.ok(runs.length > 0, id);
    assert.ok(
      runs.every((v) => v.status === 'skip' && v.reason === reason),
      `${id}: ${runs.map((v) => `${v.status} ${v.reason}`).join('; ')}`,
    );
  };
  skip('C8', 'needs core.submit');
  skip('V1-Tab-queue', 'needs core.submit');
  const c12 = byCase(verdicts, 'C12');
  assert.ok(c12.every((v) => v.status === 'skip' && v.declared === true));
});

// The runner's verdict rules: expansion to the right number of runs, skips
// that never pass, anti-vacuity, timing gates, parity compare, self-test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EditorCase } from '@murmo/fixtures';
import { compare } from '../src/compare.ts';
import { forTrust } from '../src/expect.ts';
import { loadFixtureDir } from '../src/node/fixtures.ts';
import { planSuite } from '../src/plan.ts';
import { createPureSubject } from '../src/pure.ts';
import { runSuites } from '../src/runner.ts';
import { selfTest } from '../src/self-test.ts';
import type { Capabilities, LoadedSuite, Observed, RunOptions, Subject, Verdict } from '../src/types.ts';

const options: RunOptions = { runtime: 'node', mode: 'pr', timing: 'report', now: () => performance.now() };
const { suites } = loadFixtureDir();
const suite = (file: string): LoadedSuite => {
  const found = suites.find((s) => s.file === file);
  assert.ok(found, file);
  return found;
};

/** A fully capable editor subject (planning only): unmet `requires` must not hide expansion and declared skips. */
const editorCaps: Capabilities = {
  kinds: ['editor-ops'],
  executors: ['in-process', 'isolated'],
  trust: ['builtin', 'third-party'],
  features: {
    'core.edits': true,
    'core.keys': true,
    'core.submit': true,
    'core.permissions': true,
    'core.inline': true,
    'plugin.snippets': 'release',
    'plugin.todo-guard': 'sample',
    'plugin.rescue': 'release',
    'plugin.autocorrect': 'release',
    'executor.isolated': true,
  },
};

function subjectWith(run: () => Observed, caps: Capabilities = editorCaps): Subject {
  return { name: 'scripted', caps: () => caps, run: async () => run(), dispose: async () => {} };
}

test('the 27 canonical cases expand to 70 runs: 69 to run and the declared C12 in-process skip (E3)', () => {
  const runs = planSuite(suite('core/conformance/cases.json'), editorCaps, 'core', options);
  assert.equal(runs.length, 70);
  const skipped = runs.filter((r) => r.skip);
  assert.deepEqual(
    skipped.map((r) => [r.caseId, r.executor, r.skip?.declared]),
    [['C12', 'in-process', true]],
  );
  const c13 = runs.filter((r) => r.caseId === 'C13' && r.executor === 'isolated');
  assert.deepEqual(
    c13.map((r) => (r.case as EditorCase).steps[0]),
    ['busy', 'popup', 'dialog', 'history', 'vim-normal', 'unknown'].map((state) => ({ state })),
    'every C13 variant replaces $variant with its state',
  );
});

test('a case under trust "both" runs once per trust level, with third-party fields replacing the base', () => {
  const c = {
    ...(suite('stress/ime-normalization.json') as { cases: EditorCase[] }).cases[0],
    trust: 'both',
  } as EditorCase;
  const runs = planSuite(
    { kind: 'editor-ops', file: 'x.json', owner: '02', declared: { cases: 1, variants: 1 }, cases: [c] },
    editorCaps,
    'core',
    options,
  );
  assert.deepEqual(
    runs.map((r) => `${r.trust}/${r.executor}`),
    ['builtin/in-process', 'builtin/isolated', 'third-party/in-process', 'third-party/isolated'],
  );
  const expect = forTrust({ requests: ['a'], draft: { text: 'x' }, thirdParty: { requests: [] } }, 'third-party');
  assert.deepEqual(expect, { requests: [], draft: { text: 'x' } });
});

test('a pure case whose function is not registered yet is skipped with the owning phase, never passed', async () => {
  const { verdicts } = await runSuites([suite('names/splitter.json')], createPureSubject(), options);
  assert.equal(verdicts.length, 29);
  assert.ok(
    verdicts.every((v) => v.status === 'skip' && v.reason === 'needs fn.names.splitWords (owner: phase 19, 36)'),
  );
});

test('a run that asserts nothing fails (anti-vacuity), and a subject that throws fails with the error', async () => {
  const files = [suite('stress/ime-normalization.json')];
  const empty = await runSuites(
    files,
    subjectWith(() => ({ assertions: [] })),
    options,
  );
  assert.ok(empty.verdicts.length > 0);
  assert.ok(empty.verdicts.every((v) => v.status === 'fail' && v.reason === 'asserted nothing (anti-vacuity)'));
  const throwing = await runSuites(
    files,
    subjectWith(() => {
      throw new Error('adapter crashed');
    }),
    options,
  );
  assert.ok(throwing.verdicts.every((v) => v.status === 'fail' && v.reason === 'subject threw: adapter crashed'));
});

test('a missed time budget is reported in PR runs and fails only when timing gates (nightly)', async () => {
  const slow = subjectWith(() => ({
    assertions: [
      { what: 'draft text', ok: true },
      { what: 'every change within 16 ms of the control', ok: false, timing: true, expected: 16, actual: 40 },
    ],
  }));
  const files = [suite('stress/huge-paste.json')];
  const pr = await runSuites(files, slow, options);
  assert.ok(pr.verdicts.every((v) => v.status === 'pass' && v.timing?.overBudget === 1));
  const nightly = await runSuites(files, slow, { ...options, timing: 'gate' });
  assert.ok(nightly.verdicts.every((v) => v.status === 'fail' && v.reason?.startsWith('every change within 16 ms')));
});

const verdict = (runtime: string, status: Verdict['status'], extra: Partial<Verdict> = {}): Verdict => ({
  suite: 'text/offsets-r7.json',
  case: 'emoji',
  subject: 'pure',
  runtime,
  executor: 'none',
  status,
  assertions: status === 'skip' ? 0 : 1,
  ms: 1,
  ...extra,
});

test('compare fails on a planted runtime difference and passes once the case declares that skip (E1)', () => {
  const agree = ['node', 'bun', 'quickjs-wasm', 'rquickjs'].map((rt) => verdict(rt, 'pass', { outputHash: 'h' }));
  assert.deepEqual(compare(agree), []);
  const planted = agree.map((v) =>
    v.runtime === 'rquickjs' ? { ...v, status: 'fail' as const, reason: 'offsets differ' } : v,
  );
  assert.equal(compare(planted).length, 1);
  assert.match(compare(planted)[0] ?? '', /rquickjs\/none fail \(offsets differ\)/);
  const declared = agree.map((v) =>
    v.runtime === 'rquickjs'
      ? { ...v, status: 'skip' as const, declared: true, reason: 'no Intl.Segmenter until phase 04' }
      : v,
  );
  assert.deepEqual(compare(declared), []);
  const undeclared = declared.map((v) => (v.runtime === 'rquickjs' ? { ...v, declared: false } : v));
  assert.equal(compare(undeclared).length, 1, 'a capability skip is still a difference');
});

test('compare catches a different result under the same status, and a runtime with no verdict', () => {
  const hashes = [verdict('node', 'pass', { outputHash: 'a' }), verdict('bun', 'pass', { outputHash: 'b' })];
  assert.match(compare(hashes)[0] ?? '', /results differ/);
  const missing = [
    ...hashes.map((v) => ({ ...v, outputHash: 'a' })),
    verdict('node', 'pass', { case: 'ascii', outputHash: 'a' }),
  ];
  assert.deepEqual(compare(missing), ['text/offsets-r7.json ascii: no verdict on bun/none']);
});

test('self-test sees a flipped expectation fail in a real suite, and flags a subject that ignores expectations', async () => {
  const caught = await selfTest(suites, createPureSubject(), options);
  assert.equal(caught.find((r) => r.suite === 'generators/streams.json')?.outcome, 'caught');
  const pureCaps: Capabilities = {
    kinds: ['pure-fn'],
    executors: ['none'],
    trust: [],
    features: { 'fn.generators.summary': true },
  };
  const blind = subjectWith(() => ({ assertions: [{ what: 'looked fine', ok: true }] }), pureCaps);
  const missed = await selfTest(suites, blind, options);
  assert.equal(missed.find((r) => r.suite === 'generators/streams.json')?.outcome, 'missed');
});

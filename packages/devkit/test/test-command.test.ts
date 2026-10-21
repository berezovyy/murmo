// plugin test: scaffold passes, missing routes are named, helper skip is clear (E1, E3).
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAuthorConformance } from '../src/conformance.ts';
import { pluginNew } from '../src/plugin-new.ts';
import { pluginTest } from '../src/plugin-test.ts';
import { assertExecutorRoutes, MissingRouteError } from '../src/routes.ts';

test('canonical conformance still passes on the published fake host (71 + skip)', async () => {
  const contract = await runAuthorConformance();
  assert.equal(contract.invariants.passed, true);
  assert.equal(contract.failed.length, 0);
  assert.ok(contract.cases.passed > 0);
});

test('fresh scaffold passes test on in-process (E3)', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'murmo-test-'));
  const dir = await pluginNew('counter', parent);
  const report = await pluginTest(dir, { executor: 'in-process', skipConformance: true });
  assert.equal(report.plugin, 'counter');
  assert.equal(report.authorTests, 1);
  assert.equal(report.contract.invariants.passed, true);
  assert.ok(report.contract.cases.failed === 0);
});

test('removing a route from executor stats fails naming that route (lesson 73)', () => {
  assert.throws(
    () =>
      assertExecutorRoutes('helper', {
        services: { storage: 'brokered', projectRead: undefined, submitCommitted: true, projectFileChange: true },
      }),
    (error: unknown) => error instanceof MissingRouteError && error.route === 'project.read',
  );
  assert.throws(
    () =>
      assertExecutorRoutes('helper', {
        services: { storage: undefined, projectRead: 'brokered', submitCommitted: true, projectFileChange: true },
      }),
    (error: unknown) => error instanceof MissingRouteError && error.route === 'storage',
  );
  assert.throws(
    () =>
      assertExecutorRoutes('helper', {
        services: { storage: 'brokered', projectRead: 'brokered', submitCommitted: false, projectFileChange: true },
      }),
    (error: unknown) => error instanceof MissingRouteError && error.route === 'onSubmitCommitted',
  );
});

test('route-parity plugin passes in-process and QuickJS (E1)', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'murmo-route-'));
  const dir = await pluginNew('counter', parent);
  const report = await pluginTest(dir, { executor: 'quickjs', skipConformance: true });
  assert.ok(report.executors.includes('quickjs'));
  assert.ok(report.routes.some((r) => r.executor === 'quickjs' && r.ok));
});

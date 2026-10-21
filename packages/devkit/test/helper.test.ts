// Helper route: real murmo-plugin-host, or a clear skip (plan 11 risk).
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { helperPath } from '../src/executors.ts';
import { pluginNew } from '../src/plugin-new.ts';
import { pluginTest } from '../src/plugin-test.ts';

test('plugin test --executor helper passes through murmo-plugin-host or names the skip (E1)', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'murmo-helper-'));
  const dir = await pluginNew('counter', parent);
  const report = await pluginTest(dir, { executor: 'helper', skipConformance: true });
  if (helperPath()) {
    assert.ok(report.executors.includes('helper'), JSON.stringify(report.skipped));
    assert.equal(report.authorTests, 1);
  } else {
    assert.equal(report.executors.length, 0);
    assert.ok(report.skipped.some((s) => s.executor === 'helper' && /not built/.test(s.reason)));
  }
});

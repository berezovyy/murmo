// The API report gate: while @murmo/api is a preview its types are the only
// contract, so a type change without a CHANGELOG entry is a silent breaking
// change for authors (phase 03, E1).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changedSince, changelogPath, diffReports, generate, readReport, reportPath, verdict } from '../api-report.mjs';
import { root } from '../workspace.mjs';

test('the committed report matches a fresh build, and a planted type change makes it stale', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'murmo-api-report-test-'));
  try {
    const fresh = generate(join(scratch, 'fresh'));
    const committed = readReport(join(root, reportPath));
    assert.deepEqual(diffReports(committed, fresh), [], 'run `pnpm api:report` and commit packages/api/report');

    const planted = { ...committed, 'limits.d.ts': `${committed['limits.d.ts']}export declare const NEW = 1;\n` };
    assert.deepEqual(diffReports(planted, fresh), ['limits.d.ts']);
    assert.match(verdict({ stale: diffReports(planted, fresh), changed: null }).join('\n'), /stale \(limits\.d\.ts\)/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a report change since the base needs a CHANGELOG change; a CHANGELOG-only change passes', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'murmo-api-gate-')));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  const write = (path, text) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  try {
    git('init', '-q');
    write(`${reportPath}/index.d.ts`, 'export declare const A = 1;\n');
    write(changelogPath, '# Changelog\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').toString().trim();

    assert.deepEqual(verdict({ stale: [], changed: changedSince(base, repo) }), [], 'no change passes');

    write(`${reportPath}/index.d.ts`, 'export declare const A = 2;\n');
    const problems = verdict({ stale: [], changed: changedSince(base, repo) });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /CHANGELOG\.md did not/);

    write(changelogPath, `${readFileSync(join(repo, changelogPath), 'utf8')}- A is now 2.\n`);
    assert.deepEqual(verdict({ stale: [], changed: changedSince(base, repo) }), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

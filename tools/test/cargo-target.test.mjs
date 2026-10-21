// Every worktree must build into the main checkout's one shared target folder:
// per-checkout target/ folders once filled about 150 GB (AGENTS.md).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { targetDir } from '../cargo.mjs';

test('a linked worktree resolves to the same target folder as the main checkout', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'murmo-wt-')));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    const main = join(base, 'main');
    execFileSync('git', ['init', '-q', main]);
    writeFileSync(join(main, 'f'), 'x');
    git(main, 'add', 'f');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    git(main, 'worktree', 'add', '-q', join(base, 'other'));
    const env = {};
    const expected = join(main, 'experiments', '.cache', 'cargo-target', 'murmo');
    assert.equal(targetDir({ env, cwd: main }), expected);
    assert.equal(targetDir({ env, cwd: join(base, 'other') }), expected);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

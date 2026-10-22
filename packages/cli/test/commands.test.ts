// Mounted commands from 11/14/15/19 actually dispatch.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { capture, cliPath, makeHome } from './helpers.ts';

test('words list, data show, private status, trust --list run against a throwaway store', async () => {
  const t = makeHome('murmo-commands-');
  try {
    const io = capture();
    assert.equal(await main(['words', 'list'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }), 0);
    assert.equal(await main(['data', 'show'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }), 0);
    assert.equal(
      await main(['private', 'status', '--json'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }),
      0,
    );
    assert.equal(await main(['trust', '--list'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }), 0);
    assert.equal(await main(['init', '--user'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }), 0);
    assert.equal(await main(['names', 'status'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }), 0);
    assert.equal(await main(['vocab', 'show'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }), 0);
    assert.equal(
      await main(['vocab', 'wipe', '--project'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }),
      0,
    );
  } finally {
    t.remove();
  }
});

test('murmo trust approves when the review is answered on stdin', async () => {
  // Catches a review prompt nobody can answer: the CLI never passed `ask`, so
  // `murmo trust` printed the shortcuts and always ended "Not approved."
  const t = makeHome('murmo-trust-cli-');
  try {
    const repo = join(t.root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.murmo.toml'), `version = 1\n[replace]\n";hp" = 'harness project shortcut'\n`);
    const run = (args: string[], input?: string) =>
      spawnSync(process.execPath, [cliPath, ...args], { cwd: repo, env: t.env, input, encoding: 'utf8' });
    const declined = run(['trust'], 'n\n');
    assert.equal(declined.status, 0, declined.stderr);
    assert.match(declined.stdout, /Not approved\./);
    const approved = run(['trust'], 'y\n');
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.stdout, /Approved 1 shortcut/);
    assert.match(run(['trust', '--list']).stdout, /1 shortcut/);
  } finally {
    t.remove();
  }
});

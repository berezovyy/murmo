// Lock busy and dead-owner / PID-reuse reclaim (docs/plan/27, r12 I4).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { CliError } from '../src/errors.ts';
import { acquireLock, lockDir, processStartToken, releaseLock } from '../src/lock.ts';
import { makeHome } from './helpers.ts';

test('a live owner with the same start time is lock busy', () => {
  const t = makeHome('murmo-lock-busy-');
  try {
    const held = acquireLock(t.env.XDG_DATA_HOME as string, t.env);
    try {
      assert.throws(
        () => acquireLock(t.env.XDG_DATA_HOME as string, t.env),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.match(error.message, /lock busy/);
          return true;
        },
      );
    } finally {
      releaseLock(held);
    }
  } finally {
    t.remove();
  }
});

test('a dead-pid lock is reclaimed', () => {
  const t = makeHome('murmo-lock-dead-');
  try {
    const dir = lockDir(t.env.XDG_DATA_HOME as string, t.env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/owner.json`, `${JSON.stringify({ pid: 999999, start: 'gone' })}\n`);
    const held = acquireLock(t.env.XDG_DATA_HOME as string, t.env);
    releaseLock(held);
  } finally {
    t.remove();
  }
});

test('a live pid with a different start time is treated as reuse and reclaimed', () => {
  const t = makeHome('murmo-lock-reuse-');
  try {
    const dir = lockDir(t.env.XDG_DATA_HOME as string, t.env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/owner.json`, `${JSON.stringify({ pid: process.pid, start: 'not-our-start' })}\n`);
    const real = processStartToken(process.pid);
    assert.ok(real);
    assert.notEqual(real, 'not-our-start');
    const held = acquireLock(t.env.XDG_DATA_HOME as string, t.env);
    releaseLock(held);
  } finally {
    t.remove();
  }
});

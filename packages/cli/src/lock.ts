// Setup lock in $TMPDIR: mkdir, owner pid + process start time. Reclaim only
// when that process is gone or the PID was reused (docs/plan/27, r12 I4).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from './errors.ts';

export interface LockOwner {
  readonly pid: number;
  readonly start: string;
}

export interface HeldLock {
  readonly dir: string;
}

const BUSY = {
  action: 'wait for the other murmo setup to finish, or close the stuck process',
} as const;

export function lockDir(store: string, env: NodeJS.ProcessEnv = process.env): string {
  const hash = createHash('sha256').update(store).digest('hex').slice(0, 20);
  return join(env.TMPDIR || tmpdir(), `murmo-lock-${hash}`);
}

/** Linux starttime from /proc, else `ps -o lstart`; undefined if the pid is gone. */
const SELF_START = String(Math.trunc(Date.now() - process.uptime() * 1000));

export function processStartToken(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid) return SELF_START;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close >= 0) {
      const fields = raw.slice(close + 2).split(' ');
      const start = fields[19];
      if (start) return start;
    }
  } catch {
    // macOS has no /proc.
  }
  const run = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  if (run.status !== 0) return undefined;
  const token = run.stdout.trim();
  return token || undefined;
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ownerPath(dir: string): string {
  return join(dir, 'owner.json');
}

function readOwner(dir: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(ownerPath(dir), 'utf8')) as Partial<LockOwner>;
    if (typeof value.pid === 'number' && typeof value.start === 'string') return value as LockOwner;
  } catch {
    // Missing or unreadable: treat as dead so the next acquire reclaims.
  }
  return undefined;
}

function ownerHolds(owner: LockOwner): boolean {
  if (!processAlive(owner.pid)) return false;
  const start = processStartToken(owner.pid);
  // Same pid, different start: the pid was reused (the new check this phase adds).
  if (start !== undefined && start !== owner.start) return false;
  return true;
}

function writeOwner(dir: string, owner: LockOwner): void {
  const dest = ownerPath(dir);
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  renameSync(tmp, dest);
}

function reclaim(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function acquireLock(store: string, env: NodeJS.ProcessEnv = process.env): HeldLock {
  const dir = lockDir(store, env);
  const start = processStartToken(process.pid) ?? `pid-${process.pid}`;
  try {
    mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = readOwner(dir);
    if (owner && ownerHolds(owner)) throw new CliError('setup lock busy', BUSY);
    reclaim(dir);
    try {
      mkdirSync(dir);
    } catch (retry) {
      if ((retry as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('setup lock busy', BUSY);
      throw retry;
    }
  }
  writeOwner(dir, { pid: process.pid, start });
  return { dir };
}

export function releaseLock(held: HeldLock | undefined): void {
  if (!held) return;
  if (existsSync(held.dir)) rmSync(held.dir, { recursive: true, force: true });
}

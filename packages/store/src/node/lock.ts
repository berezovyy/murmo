// The interprocess lock for records and snapshot swaps: `<file>.lock` holds
// `{"pid","acquiredAt","token"}`. It is created whole with link(2), which
// fails if the lock exists, so no reader ever sees a half-written lock. Retry
// every 10 ms (opencode-snippets, knowledge § 7), give up after 2 s with
// `busy`, and reclaim only a lock whose owner is dead or that is older than
// 30 s. The Rust backend (rust/src/lock.rs) speaks the same protocol, so a
// Node session, the helper and the Codex wrapper exclude each other.
//
// Advisory and best effort: not for `<data>` on NFS (phase 14 risks).
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorCode, FILE_MODE, processAlive, tempPath } from './files.ts';

export const LOCK_RETRY_MS = 10;
export const LOCK_TIMEOUT_MS = 2000;
export const LOCK_STALE_MS = 30_000;

export interface LockOptions {
  readonly retryMs?: number;
  readonly timeoutMs?: number;
  readonly staleMs?: number;
}

export interface HeldLock {
  /**
   * Whether the lock file still holds this owner's token. Checked right
   * before a commit: if another process reclaimed the lock (this one stalled
   * past 30 s), the commit is abandoned instead of racing it.
   */
  stillHeld(): Promise<boolean>;
}

export type Locked<T> = { readonly status: 'ok'; readonly value: T } | { readonly status: 'busy' };

interface LockContent {
  readonly pid: number;
  readonly acquiredAt: number;
  readonly token: string;
}

/** In-process queue per lock path: two calls in one process wait on a promise, not on 10 ms polls. */
const queues = new Map<string, Promise<unknown>>();

export function lockPath(target: string): string {
  return `${target}.lock`;
}

/** Runs `fn` while holding the lock for `target`. */
export async function withLock<T>(
  target: string,
  fn: (held: HeldLock) => Promise<T>,
  options: LockOptions = {},
): Promise<Locked<T>> {
  const previous = queues.get(target) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => locked(target, fn, options));
  queues.set(target, run);
  try {
    return await run;
  } finally {
    if (queues.get(target) === run) queues.delete(target);
  }
}

async function locked<T>(target: string, fn: (held: HeldLock) => Promise<T>, options: LockOptions): Promise<Locked<T>> {
  const path = lockPath(target);
  const token = randomBytes(16).toString('hex');
  if (!(await acquire(path, token, options))) return { status: 'busy' };
  const held: HeldLock = { stillHeld: async () => (await readLock(path))?.token === token };
  try {
    return { status: 'ok', value: await fn(held) };
  } finally {
    await release(path, token);
  }
}

async function acquire(path: string, token: string, options: LockOptions): Promise<boolean> {
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const content: LockContent = { pid: process.pid, acquiredAt: Date.now(), token };
  const temp = tempPath(path);
  const handle = await fsp.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(content)}\n`);
  } finally {
    await handle.close();
  }
  try {
    for (;;) {
      try {
        await fsp.link(temp, path);
        return true;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      const holder = await inspect(path, staleMs);
      if (holder.stale) {
        await reclaim(path, holder.token);
        continue;
      }
      if (Date.now() >= deadline) return false;
      await sleep(retryMs);
    }
  } finally {
    await fsp.rm(temp, { force: true });
  }
}

async function readLock(path: string): Promise<LockContent | undefined> {
  try {
    const value = JSON.parse(await fsp.readFile(path, 'utf8')) as Partial<LockContent>;
    if (typeof value.pid === 'number' && typeof value.acquiredAt === 'number' && typeof value.token === 'string') {
      return value as LockContent;
    }
  } catch {
    // Missing or not ours: the caller decides from the file's age.
  }
  return undefined;
}

/** Whether the current lock may be reclaimed, and the token it held when judged. */
async function inspect(path: string, staleMs: number): Promise<{ stale: boolean; token: string | undefined }> {
  const content = await readLock(path);
  if (content) {
    const stale = !processAlive(content.pid) || Date.now() - content.acquiredAt > staleMs;
    return { stale, token: content.token };
  }
  try {
    // Unparseable (written by something else): only age can free it.
    const st = await fsp.lstat(path);
    return { stale: Date.now() - st.mtimeMs > staleMs, token: undefined };
  } catch {
    // Gone already: try again at once.
    return { stale: false, token: undefined };
  }
}

/**
 * Moves the stale lock aside by rename (atomic: one reclaimer wins), then
 * checks that what it moved is the lock it judged. If another process had
 * already reclaimed and taken a fresh lock in between, the fresh lock is put
 * back with link(2); should that fail too, its owner's `stillHeld` check
 * refuses the commit.
 */
async function reclaim(path: string, judged: string | undefined): Promise<void> {
  const aside = tempPath(path, '.stale');
  try {
    await fsp.rename(path, aside);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  try {
    const moved = await readLock(aside);
    if (moved && moved.token !== judged) {
      await fsp.link(aside, path).catch(() => {});
    }
  } finally {
    await fsp.rm(aside, { force: true });
  }
}

async function release(path: string, token: string): Promise<void> {
  // Never remove a lock another process now holds.
  if ((await readLock(path))?.token === token) await fsp.rm(path, { force: true });
}

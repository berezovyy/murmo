// Spawn `murmo-plugin-host --http --socket` and talk to it over `fetch` with a
// Unix `socketPath`. Socket names stay short: a long path exited 101 on macOS (E11).

import type { Clock } from '@murmo/api';
import { utf8Length } from '@murmo/config';
import { createIsolatedExecutor, createSocketTransport, type HelperTransport } from '@murmo/executor';
import type { HostServices } from './types.ts';

const READY_MS = 4000;
const SHUTDOWN_MS = 500;

export interface HelperHandle {
  readonly socketPath: string;
  readonly pid?: number | undefined;
  transport(): HelperTransport;
  dispose(): Promise<void>;
}

/** One helper process: `exited` settles when it ends, however it ends. */
export interface HelperProcess extends HelperHandle {
  readonly exited: Promise<void>;
}

/**
 * Waits before each restart of a helper that died mid-session. Three in all:
 * a helper that keeps dying stays down instead of respawning forever. The
 * first wait also outlasts Claude's exit, which SIGTERMs the helper a few
 * milliseconds before `session.end` disposes it.
 */
export const HELPER_RESTART_DELAYS_MS: readonly number[] = [500, 2000, 8000];

export interface HelperWatch {
  /** The helper ended on its own (killed or crashed); a restart follows while the bound allows. */
  readonly onExit?: () => void;
  /** A restarted helper is ready. */
  readonly onRestart?: () => void;
  /** No restart is left: the helper stays down for the rest of the session. */
  readonly onGiveUp?: (why: string) => void;
}

/** `sun_path` holds 104 bytes on macOS (108 on Linux), the terminating NUL included. */
const SOCKET_PATH_MAX = 103;
const SOCKET_NAME = 'murmo-00000000.sock';

function shortId(): string {
  return Math.random().toString(16).slice(2, 10).padStart(8, '0');
}

/**
 * `$TMPDIR` without a trailing slash, or `/tmp` when it is unset or so deep
 * that the socket path would not fit `sun_path`: the helper cannot bind it and
 * exits before ready (E11, and the phase 20 harness's per-case `TMPDIR`).
 */
export function socketDir(tmpdir: string | undefined): string {
  const dir = (tmpdir || '/tmp').replace(/\/+$/, '') || '/tmp';
  return utf8Length(`${dir}/${SOCKET_NAME}`) <= SOCKET_PATH_MAX ? dir : '/tmp';
}

export async function spawnHelper(
  services: HostServices,
  binary: string,
  dir: string,
  clock: Clock,
  readyMs = READY_MS,
): Promise<HelperProcess> {
  const socketPath = `${dir}/murmo-${shortId()}.sock`;
  const stream = services.spawn([binary, '--http', '--socket', socketPath]);
  let settled = false;
  let resolveReady: (info: { pid?: number }) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<{ pid?: number }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const ended = (async () => {
    let output = '';
    try {
      for await (const piece of stream) {
        if (piece.stream !== 'stdout') continue;
        output += piece.text;
        const nl = output.indexOf('\n');
        if (nl < 0) continue;
        const line = output.slice(0, nl);
        const info = JSON.parse(line) as { ready?: boolean; pid?: number };
        if (info.ready) {
          if (!settled) {
            settled = true;
            resolveReady(info.pid === undefined ? {} : { pid: info.pid });
          }
        }
      }
      if (!settled) {
        settled = true;
        rejectReady(new Error('helper exited before ready'));
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        rejectReady(error instanceof Error ? error : new Error(String(error)));
      }
    }
  })();
  const timeout = clock.sleep(readyMs).then(() => {
    throw new Error(`helper not ready within ${readyMs} ms`);
  });
  let info: { pid?: number };
  try {
    info = await Promise.race([ready, timeout]);
  } catch (error) {
    await stream.return?.();
    throw error;
  }
  const transport = createSocketTransport({
    socketPath,
    fetch: (url, init) => services.fetch(url, init),
  });
  return {
    socketPath,
    ...(info.pid === undefined ? {} : { pid: info.pid }),
    exited: ended,
    transport: () => transport,
    async dispose() {
      // `shutdown` lets the helper stop its workers and remove its socket, so
      // the stream is ended (the process killed) only when it does not exit.
      const late = clock.sleep(SHUTDOWN_MS).then(() => false);
      const asked = transport.request({ op: 'shutdown' }).then(
        (reply) => reply.status === 'ok',
        () => false,
      );
      const exited = (await Promise.race([asked, late])) && (await Promise.race([ended.then(() => true), late]));
      await transport.close();
      if (!exited) await stream.return?.();
    },
  };
}

/** The first of `binaries` that starts: a payload may carry helpers for several platforms. */
export async function startHelper(
  services: HostServices,
  binaries: readonly string[],
  dir: string,
  clock: Clock,
  readyMs = READY_MS,
): Promise<HelperProcess> {
  let last: unknown = new Error('no helper binary in the payload');
  for (const binary of binaries) {
    try {
      return await spawnHelper(services, binary, dir, clock, readyMs);
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/**
 * `startHelper`, then a restart whenever the helper ends on its own, within
 * `delays`. The handle always talks to the helper that is running now, so
 * whoever holds it keeps working across a restart.
 */
export async function superviseHelper(
  services: HostServices,
  binaries: readonly string[],
  dir: string,
  clock: Clock,
  readyMs: number,
  watch: HelperWatch = {},
  delays: readonly number[] = HELPER_RESTART_DELAYS_MS,
): Promise<HelperHandle> {
  let current = await startHelper(services, binaries, dir, clock, readyMs);
  let disposed = false;
  let restarts = 0;
  const follow = (child: HelperProcess): void => {
    void child.exited.then(() => {
      if (!disposed && child === current) void restart();
    });
  };
  const restart = async (): Promise<void> => {
    watch.onExit?.();
    let why = 'it exited';
    while (restarts < delays.length) {
      await clock.sleep(delays[restarts++] ?? 0);
      if (disposed) return;
      try {
        const child = await startHelper(services, binaries, dir, clock, readyMs);
        if (disposed) {
          await child.dispose();
          return;
        }
        current = child;
        follow(child);
        watch.onRestart?.();
        return;
      } catch (error) {
        why = error instanceof Error ? error.message : String(error);
      }
    }
    watch.onGiveUp?.(why);
  };
  follow(current);
  return {
    get socketPath() {
      return current.socketPath;
    },
    get pid() {
      return current.pid;
    },
    transport: () => current.transport(),
    async dispose() {
      disposed = true;
      await current.dispose();
    },
  };
}

export function isolatedFrom(handle: HelperHandle, clock: Clock) {
  return createIsolatedExecutor({
    clock,
    connect: () => handle.transport(),
  });
}

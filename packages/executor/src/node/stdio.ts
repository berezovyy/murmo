// Stdio JSON-lines transport to a spawned murmo-plugin-host supervisor.

import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { executorFault } from '../fault.ts';
import type { HelperTransport } from '../helper.ts';

export interface StdioTransportOptions {
  readonly bin: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly transportTimeoutMs?: number;
}

export function createStdioTransport(options: StdioTransportOptions): HelperTransport {
  const child: ChildProcess = spawn(options.bin, [...(options.args ?? [])], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env ?? process.env,
  });
  const pending = new Map<
    number,
    {
      resolve: (row: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const exits = new Set<(code: number | null) => void>();
  let sequence = 0;
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timeoutMs = options.transportTimeoutMs ?? 8_000;
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (!stdout || !stdin) throw executorFault('transport', 'helper stdio not piped');

  createInterface({ input: stdout }).on('line', (line) => {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (row.ready) {
      readyResolve();
      return;
    }
    const id = typeof row.id === 'number' ? row.id : Number(row.id);
    const waiter = pending.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(id);
      waiter.resolve(row);
    }
  });
  child.stderr?.resume();
  child.once('error', (error) => readyReject(executorFault('transport', error.message)));
  child.once('exit', (code) => {
    const error = executorFault('session-exit', `helper exited (${code})`);
    readyReject(error);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    for (const cb of exits) cb(code);
  });

  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    async request(message) {
      await ready;
      if (child.exitCode !== null) throw executorFault('session-exit', 'helper exited');
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(executorFault('transport', 'helper transport timeout', { invocationId: id }));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        stdin.write(`${JSON.stringify({ ...message, id })}\n`);
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      stdin.write('{"op":"shutdown"}\n');
      stdin.end();
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 1000);
      });
    },
    onExit(callback) {
      exits.add(callback);
      return () => {
        exits.delete(callback);
      };
    },
  };
}

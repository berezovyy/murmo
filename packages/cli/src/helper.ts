// Helper ping and first-party guest load. A ping alone never marks a
// capability green (lesson 76 / E10).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const PROTOCOL = 1;
const API_VERSION = '2.0.0';

export interface HelperCheck {
  readonly ping: boolean;
  readonly guest: boolean;
  readonly pid?: number;
  readonly detail: string;
}

interface RpcRow {
  readonly id?: number;
  readonly ready?: boolean;
  readonly status?: string;
  readonly pong?: boolean;
  readonly error?: string;
}

export async function checkHelper(bin: string, payload: string, timeoutMs = 8_000): Promise<HelperCheck> {
  if (!existsSync(bin)) return { ping: false, guest: false, detail: `${bin} is missing` };
  const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve: (row: RpcRow) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (!stdout || !stdin) {
    child.kill();
    return { ping: false, guest: false, detail: 'helper stdio not piped' };
  }
  createInterface({ input: stdout }).on('line', (line) => {
    let row: RpcRow;
    try {
      row = JSON.parse(line) as RpcRow;
    } catch {
      return;
    }
    if (row.ready) {
      readyResolve();
      return;
    }
    const waiter = typeof row.id === 'number' ? pending.get(row.id) : undefined;
    if (waiter) {
      pending.delete(row.id as number);
      waiter.resolve(row);
    }
  });
  child.stderr?.resume();
  child.once('error', (error) => readyReject(error));
  child.once('exit', (code) => {
    const error = new Error(`helper exited (${code})`);
    readyReject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  const request = async (message: Record<string, unknown>): Promise<RpcRow> => {
    await ready;
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`helper ${String(message.op)} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (row) => {
          clearTimeout(timer);
          resolve(row);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    });
  };

  try {
    const hello = await request({ op: 'hello', protocol: PROTOCOL, apiVersion: API_VERSION });
    if (hello.status !== 'ok') {
      return {
        ping: false,
        guest: false,
        detail: 'hello failed',
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
      };
    }
    const ping = await request({ op: 'ping' });
    const pingOk = ping.status === 'ok' && ping.pong === true;
    let guest = false;
    const plugin = join(payload, 'plugins', 'autocorrect', 'plugin.js');
    if (existsSync(plugin)) {
      const load = await request({
        op: 'load',
        plugin: 'first-party',
        source: readFileSync(plugin, 'utf8'),
        format: 'esm',
        settings: {},
        memoryMiB: 8,
      });
      guest = load.status === 'ok';
    }
    await request({ op: 'shutdown' }).catch(() => {});
    return {
      ping: pingOk,
      guest,
      detail: pingOk
        ? guest
          ? 'ping and first-party guest ok'
          : 'ping ok; first-party guest did not load'
        : 'ping failed',
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
    };
  } catch (error) {
    return {
      ping: false,
      guest: false,
      detail: error instanceof Error ? error.message : String(error),
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
    };
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

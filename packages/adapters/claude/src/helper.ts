// Spawn `murmo-plugin-host --http --socket` and talk over `rt.http.fetch`.
// Socket names stay short: a long path exited 101 on macOS (E11).

import type { Clock } from '@murmo/api';
import { createIsolatedExecutor, createSocketTransport, type HelperTransport } from '@murmo/executor';
import type { ClaudeRuntime, SpawnStream } from './types.ts';

const READY_MS = 4000;

export interface HelperHandle {
  readonly socketPath: string;
  readonly pid?: number;
  transport(): HelperTransport;
  dispose(): Promise<void>;
}

function shortId(): string {
  return Math.random().toString(16).slice(2, 10);
}

export async function socketDir(rt: ClaudeRuntime): Promise<string> {
  const tmp = (await rt.env.get('TMPDIR')) || '/tmp';
  return tmp.replace(/\/$/, '');
}

export async function spawnHelper(rt: ClaudeRuntime, binary: string, clock: Clock): Promise<HelperHandle> {
  const socketPath = `${await socketDir(rt)}/murmo-${shortId()}.sock`;
  const hostProcess = rt.process;
  const stream: SpawnStream = hostProcess.spawn({ argv: [binary, '--http', '--socket', socketPath] });
  let settled = false;
  let resolveReady: (info: { pid?: number }) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<{ pid?: number }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void (async () => {
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
  const timeout = clock.sleep(READY_MS).then(() => {
    throw new Error('helper startup timeout');
  });
  const info = await Promise.race([ready, timeout]);
  const transport = createSocketTransport({
    socketPath,
    fetch: (url, init) => rt.http.fetch(url, init),
  });
  return {
    socketPath,
    ...(info.pid === undefined ? {} : { pid: info.pid }),
    transport: () => transport,
    async dispose() {
      await transport.close();
      await stream.return?.();
    },
  };
}

export function isolatedFrom(handle: HelperHandle, clock: Clock) {
  return createIsolatedExecutor({
    clock,
    connect: () => handle.transport(),
  });
}

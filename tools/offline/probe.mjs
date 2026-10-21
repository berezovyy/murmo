// Fails unless outbound connections are blocked. 203.0.113.1 (TEST-NET-3) is
// never routable: with a network it hangs until the timeout, and blocked it
// fails at once (EPERM under sandbox-exec, ENETUNREACH under --network none).
import net from 'node:net';

const blocked = new Set(['EPERM', 'EACCES', 'ENETUNREACH', 'EHOSTUNREACH']);

export function probe(host = '203.0.113.1', port = 9, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => done({ offline: false, reason: 'connected' }));
    socket.once('error', (/** @type {NodeJS.ErrnoException} */ error) =>
      done({ offline: blocked.has(error.code ?? ''), reason: error.code }),
    );
    socket.setTimeout(timeoutMs, () => done({ offline: false, reason: 'timeout (a route exists)' }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await probe();
  if (!result.offline) {
    console.error(`network is reachable (${result.reason}); run tests through tools/offline/run.sh`);
    process.exitCode = 1;
  }
}

"""The network trap: a loopback proxy that refuses everything and names it.

The sandbox blocks every outbound connection, but macOS redacts the remote
address in its denial records and a `--network none` container records
nothing, so a blocked attempt would carry no hostname for the watchdog to
judge (rule 7). Every profile therefore points `HTTP(S)_PROXY` and
`ALL_PROXY` at this trap, with loopback excluded through `NO_PROXY`. A host
that honours the proxy variables (Node with `NODE_USE_ENV_PROXY`, Bun, git,
reqwest) sends its attempt here instead: the trap records the method and
target host (never headers, never a body), answers 403 and closes. The
watchdog scans every target, so a provider hostname stops the run.

Hosts that ignore the proxy variables still hit the sandbox, which blocks
them and, on macOS, counts them.
"""

from __future__ import annotations

import json
import socketserver
import threading
import time
from collections.abc import Callable
from pathlib import Path

_MAX_HEAD = 16384


class NetworkTrap:
    def __init__(self, log_path: Path | None = None, *, on_record: Callable[[dict], None] | None = None) -> None:
        self.log_path = log_path
        self.on_record = on_record
        self._records: list[dict] = []
        self._lock = threading.Lock()
        self._server: socketserver.ThreadingTCPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> NetworkTrap:
        trap = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                self.request.settimeout(5)
                head = b''
                try:
                    while b'\r\n' not in head and len(head) < _MAX_HEAD:
                        chunk = self.request.recv(4096)
                        if not chunk:
                            break
                        head += chunk
                except OSError:
                    pass
                # Only the request line is kept: method and target.
                line = head.split(b'\r\n', 1)[0].decode('latin-1', 'replace')
                parts = line.split(' ')
                method = parts[0] if parts else ''
                target = parts[1] if len(parts) > 1 else ''
                trap._record({'method': method[:16], 'target': target[:512]})
                try:
                    self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                except OSError:
                    pass

        class Server(socketserver.ThreadingTCPServer):
            daemon_threads = True
            allow_reuse_address = True

        self._server = Server(('127.0.0.1', 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, name='network-trap', daemon=True)
        self._thread.start()
        return self

    @property
    def port(self) -> int:
        assert self._server is not None
        return self._server.server_address[1]

    @property
    def url(self) -> str:
        return f'http://127.0.0.1:{self.port}'

    def records(self) -> list[dict]:
        with self._lock:
            return list(self._records)

    def _record(self, record: dict) -> None:
        record = {'at': round(time.time(), 3), **record}
        with self._lock:
            self._records.append(record)
        if self.log_path is not None:
            with self.log_path.open('a', encoding='utf-8') as handle:
                handle.write(json.dumps(record) + '\n')
        if self.on_record is not None:
            self.on_record(record)

    def close(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None


def proxy_env(trap_url: str) -> dict[str, str]:
    """The proxy variables every profile carries (upper and lower case: tools differ)."""
    env = {}
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'):
        env[name] = trap_url
        env[name.lower()] = trap_url
    env['NO_PROXY'] = env['no_proxy'] = '127.0.0.1,localhost,::1'
    env['NODE_USE_ENV_PROXY'] = '1'  # Node 24's fetch honours the variables only with this
    return env

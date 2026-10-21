"""tmux driver for functional contract tests.

A private server per session (`tmux -L <run id>-<n> -f harness/tmux.conf`),
never the user's server or config (rule 10). Text goes in with `send-keys -l`
(literal), named keys by tmux name, pastes with `paste-buffer -p` (bracketed
when the host asked for it). A watcher thread captures the pane every 100 ms
for the watchdog, so a provider hostname on screen stops the run within the
1 s budget even while the runner waits.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

from .. import keys, paths
from ..procs import ProcessRegistry
from ..screen import ScreenView
from ..watchdog import Watchdog
from .base import Driver

TARGET = 'main'


class TmuxDriver(Driver):
    kind = 'tmux'

    def __init__(
        self,
        argv: list[str],
        *,
        env: dict[str, str],
        cwd: Path,
        watchdog: Watchdog,
        registry: ProcessRegistry,
        socket: str,
        cols: int = 120,
        rows: int = 40,
        key_delay: float = 0.04,
        extended_keys: bool = False,
    ) -> None:
        super().__init__(watchdog, key_delay=key_delay)
        tmux = shutil.which('tmux')
        if tmux is None:
            raise RuntimeError('tmux is not installed')
        self.tmux = tmux
        self.socket = socket
        self.env = env
        self.registry = registry
        self.cols, self.rows = cols, rows
        conf = paths.TMUX_EXTENDED_CONF if extended_keys else paths.TMUX_CONF
        registry.add_marker(socket)
        self._run('-f', str(conf), 'new-session', '-d', '-s', TARGET, '-x', str(cols), '-y', str(rows), '-c', str(cwd), '--', *argv)
        info = self._run('display-message', '-p', '-t', TARGET, '#{pid} #{pane_pid} #{pane_tty} #{socket_path}').split()
        self.server_pid, self.pane_pid, self.pane_tty = int(info[0]), int(info[1]), info[2]
        self.socket_path = Path(info[3])
        registry.register(self.server_pid)
        registry.register(self.pane_pid, tty=self.pane_tty)
        self._closed = threading.Event()
        self._watcher = threading.Thread(target=self._watch, name='tmux-watch', daemon=True)
        self._watcher.start()

    def _run(self, *args: str, check: bool = True, timeout: float = 10) -> str:
        done = subprocess.run(
            [self.tmux, '-L', self.socket, *args],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if check and done.returncode != 0:
            raise RuntimeError(f'tmux {args[0]} failed: {done.stderr.strip()}')
        return done.stdout

    def _watch(self) -> None:
        while not self._closed.wait(0.1):
            try:
                view = self.screen()
            except (RuntimeError, subprocess.SubprocessError, OSError):
                continue
            self.watchdog.scan(view.text, 'screen', 'tmux-pane')
            if view.title:
                self.watchdog.scan(view.title, 'status', 'tmux-title')

    def screen(self) -> ScreenView:
        text = self._run('capture-pane', '-p', '-t', TARGET)
        meta = self._run('display-message', '-p', '-t', TARGET, '#{cursor_x}\t#{cursor_y}\t#{pane_title}')
        x, y, title = (meta.rstrip('\n').split('\t') + ['', '', ''])[:3]
        lines = text.split('\n')[: self.rows]
        lines += [''] * (self.rows - len(lines))
        return ScreenView(tuple(lines), (int(x or 0), int(y or 0)), title)

    def ansi(self) -> bytes:
        return self._run('capture-pane', '-p', '-e', '-t', TARGET).encode()

    def write(self, data: str) -> None:
        if data:
            self._run('send-keys', '-t', TARGET, '-l', '--', data)

    def write_key(self, key: str) -> None:
        self._run('send-keys', '-t', TARGET, keys.tmux_name(key))

    def paste(self, text: str, chunk: int | None = None) -> None:
        # tmux writes the buffer to the pane itself; `chunk` cannot apply here.
        self._guard()
        self._run('set-buffer', '-b', 'murmo-paste', '--', text)
        self._run('paste-buffer', '-p', '-d', '-b', 'murmo-paste', '-t', TARGET)

    def resize(self, cols: int, rows: int) -> None:
        self._run('resize-window', '-t', TARGET, '-x', str(cols), '-y', str(rows))
        self.cols, self.rows = cols, rows

    def alive(self) -> bool:
        try:
            return self._run('display-message', '-p', '-t', TARGET, '#{pane_dead}', check=False).strip() == '0'
        except (subprocess.SubprocessError, OSError):
            return False

    def root_pid(self) -> int | None:
        return self.pane_pid

    def close(self) -> None:
        self._closed.set()
        self._watcher.join(timeout=2)
        try:
            self._run('kill-server', check=False)
        except (subprocess.SubprocessError, OSError):
            pass
        self.registry.kill_session(self.pane_pid, self.pane_tty)
        self.registry.kill_session(self.server_pid)
        deadline = time.monotonic() + 2
        while self.socket_path.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        if self.socket_path.exists() and self.socket_path.name == self.socket:
            os.unlink(self.socket_path)  # our own socket, left by a killed server

"""The driver interface shared by the tmux and direct-PTY drivers."""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from collections.abc import Callable
from pathlib import Path

from .. import keys
from ..screen import ScreenView
from ..watchdog import Watchdog


class DriverRefused(RuntimeError):
    """The driver will not type: the host is in a mode where text could run as
    a command (shell mode, a menu), or the session is gone (rule 6)."""


class Driver(ABC):
    kind = 'abstract'

    def __init__(self, watchdog: Watchdog, *, key_delay: float = 0.04) -> None:
        self.watchdog = watchdog
        self.key_delay = key_delay

    # --- primitives each driver implements -------------------------------

    @abstractmethod
    def screen(self) -> ScreenView: ...

    @abstractmethod
    def ansi(self) -> bytes:
        """The raw terminal output so far (PTY) or the current pane with escapes (tmux)."""

    @abstractmethod
    def write(self, data: str) -> None:
        """Literal input, exactly as given."""

    @abstractmethod
    def write_key(self, key: str) -> None: ...

    @abstractmethod
    def paste(self, text: str, chunk: int | None = None) -> None:
        """A bracketed paste; with `chunk`, written in pieces of at most that many bytes."""

    @abstractmethod
    def resize(self, cols: int, rows: int) -> None: ...

    @abstractmethod
    def alive(self) -> bool: ...

    @abstractmethod
    def root_pid(self) -> int | None: ...

    @abstractmethod
    def close(self) -> None: ...

    # --- shared behaviour --------------------------------------------------

    def key(self, key: str) -> None:
        self._guard()
        self.write_key(key)
        if key == 'Escape':
            # Escape is its own write, then a gap, so the host never reads it
            # as the start of an escape sequence with the next key (r14 H1).
            time.sleep(keys.ESCAPE_GAP_SECONDS)

    def type(self, text: str, delay: float | None = None) -> None:
        """Key by key, with a set delay between keys."""
        gap = self.key_delay if delay is None else delay
        for char in text:
            self._guard()
            if char == '\n':
                self.write_key('Newline')
            else:
                self.write(char)
            self.drain(gap)

    def burst(self, text: str, gap: float = 0.002) -> None:
        """Keys under 8 ms apart: what a fast typist or key repeat produces."""
        for char in text:
            self._guard()
            if char == '\n':
                self.write_key('Newline')
            else:
                self.write(char)
            time.sleep(gap)

    def drain(self, seconds: float) -> None:
        """Let the host render for a while (the reader keeps going in the background)."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.watchdog.check()
            time.sleep(min(0.01, max(0.0, end - time.monotonic())))

    def wait(self, predicate: Callable[[ScreenView], bool], timeout: float) -> bool:
        end = time.monotonic() + timeout
        while True:
            self.watchdog.check()
            if predicate(self.screen()):
                return True
            if time.monotonic() >= end:
                return False
            time.sleep(0.01)

    def wait_text(self, needle: str, timeout: float) -> bool:
        return self.wait(lambda s: needle in s.text, timeout)

    def settle(self, quiet: float = 0.3, timeout: float = 5.0) -> bool:
        """Wait until the screen stops changing for `quiet` seconds."""
        end = time.monotonic() + timeout
        last = self.screen()
        since = time.monotonic()
        while time.monotonic() < end:
            self.watchdog.check()
            time.sleep(0.03)
            now = self.screen()
            if now != last:
                last, since = now, time.monotonic()
            elif time.monotonic() - since >= quiet:
                return True
        return False

    def save(self, directory: Path, label: str) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        view = self.screen()
        (directory / f'{label}.screen.txt').write_text(view.text + '\n')
        (directory / f'{label}.screen.ansi').write_bytes(self.ansi())

    def _guard(self) -> None:
        self.watchdog.check()
        if not self.alive():
            raise DriverRefused('the host session has exited')

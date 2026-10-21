"""Direct-PTY driver: the host on a pseudo-terminal of its own, its output fed
to a pyte screen by a reader thread. No multiplexer sits between the keys and
the host, which is what latency must be measured on (lesson 65).

The reader answers the terminal capability queries hosts send at startup
(cursor position, device attributes, background colour, keyboard protocol);
without answers some hosts stall (r14-plugin-load § Method). Every chunk and
every settled screen go through the watchdog.
"""

from __future__ import annotations

import codecs
import fcntl
import os
import re
import select
import struct
import subprocess
import termios
import threading
import time
from collections.abc import Callable
from pathlib import Path

from .. import keys
from ..deps import ensure_pyte
from ..procs import ProcessRegistry
from ..screen import ScreenView
from ..watchdog import Watchdog
from .base import Driver

# Queries pyte does not answer itself (it answers DSR and DA through
# write_process_input), and the replies a dark xterm would give.
_QUERY_REPLIES: tuple[tuple[bytes, str], ...] = (
    (b'\x1b[?u', '\x1b[?0u'),  # kitty keyboard protocol: supported, no flags
    (b'\x1b]11;?', '\x1b]11;rgb:0000/0000/0000\x1b\\'),  # background colour
    (b'\x1b]10;?', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'),  # foreground colour
    (b'\x1b[>0q', '\x1bP>|murmo-harness\x1b\\'),  # XTVERSION
    (b'\x1b[>q', '\x1bP>|murmo-harness\x1b\\'),
)


# String sequences pyte does not understand: APC (ESC _), PM (ESC ^), SOS (ESC X),
# ended by ST (ESC \\) or BEL.
_STRING_START = re.compile('\x1b[_^X]')
_STRING_END = re.compile('\x1b\\\\|\x07')
# CSI with a private marker pyte does not parse (kitty keyboard push/pop/set).
_PRIVATE_CSI = re.compile('\x1b\\[[<=>][0-9;:]*[ -/]*[@-~]')
_PARTIAL_CSI = re.compile('\x1b(\\[[<=>?]?[0-9;:]*)?$')


def make_screen(pyte, cols: int, rows: int, write: Callable[[str], None]):
    """A pyte screen that sends DSR / DA replies to the host through `write`.

    `CSI ? Pp m` is xterm's modifyOtherKeys query (vim sends it when Claude's
    Ctrl+G opens the editor), not a colour change: pyte passes it to
    `select_graphic_rendition` with `private=True`, which that method doesn't
    accept, and the TypeError killed the reader thread and the whole run."""

    class Screen(pyte.Screen):
        def write_process_input(self, data: str) -> None:
            write(data)

        def select_graphic_rendition(self, *attrs: int, private: bool = False) -> None:
            if not private:
                super().select_graphic_rendition(*attrs)

    return Screen(cols, rows)


class PtyDriver(Driver):
    kind = 'pty'

    def __init__(
        self,
        argv: list[str],
        *,
        env: dict[str, str],
        cwd: Path,
        watchdog: Watchdog,
        registry: ProcessRegistry,
        cols: int = 120,
        rows: int = 40,
        key_delay: float = 0.04,
    ) -> None:
        super().__init__(watchdog, key_delay=key_delay)
        pyte = ensure_pyte()
        self.registry = registry
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._raw = bytearray()
        self._chunks: list[tuple[float, int]] = []  # (perf_counter, bytes) per read
        self._decoder = codecs.getincrementaldecoder('utf-8')('replace')
        self._waiters: list[tuple[Callable[[ScreenView], bool], list[float]]] = []
        self._last_full_scan = 0.0
        self._pending_string = ''

        driver = self

        self._screen = make_screen(pyte, cols, rows, driver.write)
        self._stream = pyte.Stream(self._screen)

        master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.tty = os.ttyname(slave)
        try:
            self.process = subprocess.Popen(
                argv,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                cwd=cwd,
                env=env,
                start_new_session=True,
                # Make the PTY the controlling terminal of the new session
                # (macOS needs TIOCSCTTY; Linux does it on first open too).
                preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0),
                close_fds=True,
            )
        finally:
            os.close(slave)
        self.fd = master
        os.set_blocking(master, False)
        registry.register(self.process.pid, tty=self.tty)
        self._closed = threading.Event()
        self._reader = threading.Thread(target=self._read_loop, name='pty-reader', daemon=True)
        self._reader.start()

    # --- reading ---------------------------------------------------------

    def _read_loop(self) -> None:
        while not self._closed.is_set():
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.05)
            except (OSError, ValueError):
                return
            if not ready:
                self._scan_screen(force=False)
                continue
            try:
                data = os.read(self.fd, 65536)
            except BlockingIOError:
                continue
            except OSError:
                return  # EIO: the host closed its terminal
            if not data:
                return
            stamp = time.perf_counter()
            text = self._decoder.decode(data)
            with self._lock:
                self._raw.extend(data)
                self._chunks.append((stamp, len(data)))
                self._stream.feed(self._strip_strings(text))
                view = self._view_locked()
                for predicate, slot in self._waiters:
                    if not slot and predicate(view):
                        slot.append(stamp)
            for query, reply in _QUERY_REPLIES:
                if query in data:
                    self.write(reply)
            self.watchdog.scan(text, 'screen', 'pty-stream', stream=True)
            self._scan_screen(force=False)

    def _strip_strings(self, text: str) -> str:
        """APC, PM and SOS strings, and CSI sequences with a `<` or `=` marker,
        removed before pyte sees them: pyte draws them as text. Claude's
        kitty-graphics query (`ESC _ G ... ESC \\`) once showed up as `4;AAAA`
        in the draft, and its kitty-keyboard pop (`CSI < u`) as a stray `u`."""
        text = self._pending_string + text
        self._pending_string = ''
        out = []
        i = 0
        while True:
            start = _STRING_START.search(text, i)
            if start is None:
                rest = text[i:]
                if rest.endswith('\x1b'):
                    # A lone ESC at the end of a read may begin a string.
                    self._pending_string = '\x1b'
                    rest = rest[:-1]
                out.append(rest)
                break
            out.append(text[i : start.start()])
            end = _STRING_END.search(text, start.end())
            if end is None:
                rest = text[start.start() :]
                # Hold an unterminated string for the next read (bounded).
                self._pending_string = rest if len(rest) < 65536 else ''
                break
            i = end.end()
        joined = ''.join(out)
        # A control sequence cut off at the end of a read waits for the rest.
        partial = _PARTIAL_CSI.search(joined)
        if partial and not self._pending_string:
            self._pending_string = joined[partial.start() :]
            joined = joined[: partial.start()]
        return _PRIVATE_CSI.sub('', joined)

    def _scan_screen(self, *, force: bool) -> None:
        # Hostnames wrapped across rows only show in the rendered screen.
        now = time.monotonic()
        if not force and now - self._last_full_scan < 0.1:
            return
        self._last_full_scan = now
        view = self.screen()
        self.watchdog.scan(view.text, 'screen', 'pty-screen')
        if view.title:
            self.watchdog.scan(view.title, 'status', 'pty-title')

    def _view_locked(self) -> ScreenView:
        screen = self._screen
        return ScreenView(tuple(screen.display), (screen.cursor.x, screen.cursor.y), getattr(screen, 'title', '') or '')

    def screen(self) -> ScreenView:
        with self._lock:
            return self._view_locked()

    def ansi(self) -> bytes:
        with self._lock:
            return bytes(self._raw)

    def frames(self) -> list[tuple[float, int]]:
        with self._lock:
            return list(self._chunks)

    # --- writing ---------------------------------------------------------

    def write(self, data: str) -> None:
        self._write_bytes(data.encode())

    def _write_bytes(self, payload: bytes) -> None:
        with self._write_lock:
            while payload:
                try:
                    written = os.write(self.fd, payload)
                except BlockingIOError:
                    time.sleep(0.002)
                    continue
                except OSError:
                    return
                payload = payload[written:]

    def write_key(self, key: str) -> None:
        self.write(keys.pty_bytes(key))

    def paste(self, text: str, chunk: int | None = None) -> None:
        self._guard()
        data = keys.bracketed(text)
        if not chunk:
            self.write(data)
            return
        payload = data.encode()
        for start in range(0, len(payload), chunk):
            self._write_bytes(payload[start : start + chunk])
            time.sleep(0.02)

    def resize(self, cols: int, rows: int) -> None:
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        with self._lock:
            self._screen.resize(rows, cols)

    # --- measuring -------------------------------------------------------

    def time_to_frame(self, send: Callable[[], None], predicate: Callable[[ScreenView], bool], timeout: float) -> float | None:
        """Milliseconds from just before `send()` to the read that first made
        `predicate` true, timed in the reader thread (no polling delay)."""
        slot: list[float] = []
        with self._lock:
            self._waiters.append((predicate, slot))
        try:
            start = time.perf_counter()
            send()
            end = time.monotonic() + timeout
            while not slot and time.monotonic() < end:
                self.watchdog.check()
                time.sleep(0.001)
            return (slot[0] - start) * 1000 if slot else None
        finally:
            with self._lock:
                self._waiters.remove((predicate, slot))

    # --- lifecycle -------------------------------------------------------

    def alive(self) -> bool:
        return self.process.poll() is None

    def root_pid(self) -> int | None:
        return self.process.pid

    def close(self) -> None:
        self.registry.kill_session(self.process.pid, self.tty)
        self._closed.set()
        self._reader.join(timeout=2)
        try:
            os.close(self.fd)
        except OSError:
            pass
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)

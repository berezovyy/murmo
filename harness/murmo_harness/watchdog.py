"""Provider watchdog (safety rule 7, the stop rule).

Every screen frame, status line, host log, error output, written config,
config dump, fake-server log entry and sandbox record goes through `scan`.
A real provider hostname stops the run: every host process of the run is
killed (all hosts, not only the one that showed it), the run is marked
`STOPPED-PROVIDER`, the evidence is kept, and a global marker blocks every
later launch, in every worktree, until a person has reviewed it.

The one exception the user approved: a hostname inside a host's `--help` or
documentation text, read inside a `--network none` container.
"""

from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

from . import paths
from .safety import PROVIDER_HOST_RE

# Where scanned text came from. `help` is the only source the exception covers.
SOURCES = frozenset(
    {
        'screen',
        'status',
        'stdout',
        'stderr',
        'host-log',
        'config',
        'config-dump',
        'fake-log',
        'sandbox-record',
        'network',
        'help',
        'test',
    }
)

_ANSI = re.compile(
    r'\x1b\[[0-?]*[ -/]*[@-~]'  # CSI
    r'|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)'  # OSC
    r'|\x1bP[^\x1b]*\x1b\\'  # DCS
    r'|\x1b[()*+][0-9A-Za-z]'  # charset designation
    r'|\x1b[@-Z\\^_`a-z{|}~=>]'  # other two-byte escapes
)
_SPACE_AND_CONTROLS = re.compile(r'[\s\x00-\x1f\x7f]+')

# Characters kept from the end of each stream, so a hostname split across
# two reads (or two log lines) is still found.
_TAIL = 96


def normalize(text: str) -> str:
    """ANSI removed, every whitespace and control character removed, lower-cased."""
    return _SPACE_AND_CONTROLS.sub('', _ANSI.sub('', text)).lower()


def find_provider(text: str) -> str | None:
    """The first real provider hostname in `text`, after normalization."""
    match = PROVIDER_HOST_RE.search(normalize(text))
    return match.group(0) if match else None


class ProviderStop(RuntimeError):
    """Raised by drivers and the runner once the watchdog has stopped the run."""


@dataclass
class Hit:
    run: str
    source: str
    hostname: str
    detail: str
    at: float
    excerpt: str


class Watchdog:
    """One per run. `kill_all` must kill every host process of the run."""

    def __init__(
        self,
        run_id: str,
        evidence_dir: Path,
        kill_all: Callable[[], None],
        *,
        in_no_network_container: bool = False,
        stop_marker: Path | None = None,
    ) -> None:
        self.run_id = run_id
        self.evidence_dir = evidence_dir
        self._kill_all = kill_all
        self.in_no_network_container = in_no_network_container
        self.stop_marker = stop_marker if stop_marker is not None else paths.stop_marker()
        self.hit: Hit | None = None
        self.help_mentions: list[Hit] = []
        self.stop_seconds: float | None = None
        self._tails: dict[str, str] = {}
        self._lock = threading.Lock()
        self._files: dict[Path, tuple[str, int]] = {}
        self._thread: threading.Thread | None = None
        self._closing = threading.Event()

    @property
    def stopped(self) -> bool:
        return self.hit is not None

    def check(self) -> None:
        if self.hit is not None:
            raise ProviderStop(f'STOPPED-PROVIDER: {self.hit.hostname} in {self.hit.source} ({self.hit.detail})')

    def scan(self, text: str, source: str, detail: str = '', *, stream: bool = False) -> bool:
        """Scan one piece of text. With `stream`, the end of the previous piece of
        the same source+detail is prepended, so split hostnames are caught.
        Returns True if the run is (now) stopped."""
        if source not in SOURCES:
            raise ValueError(f'unknown watchdog source {source!r}')
        flat = normalize(text)
        key = f'{source}\0{detail}'
        if stream:
            with self._lock:
                flat = self._tails.get(key, '') + flat
                self._tails[key] = flat[-_TAIL:]
        match = PROVIDER_HOST_RE.search(flat)
        if not match:
            return self.stopped
        start = max(0, match.start() - 40)
        hit = Hit(self.run_id, source, match.group(0), detail, time.time(), flat[start : match.end() + 40])
        if source == 'help' and self.in_no_network_container:
            # The user-approved exception: help or documentation text in a
            # no-network container. Recorded, never a stop.
            self.help_mentions.append(hit)
            return self.stopped
        self._stop(hit)
        return True

    def scan_file(self, path: Path, source: str) -> bool:
        try:
            text = path.read_text(errors='replace')
        except FileNotFoundError:
            return self.stopped
        return self.scan(text, source, str(path))

    def _stop(self, hit: Hit) -> None:
        with self._lock:
            if self.hit is not None:
                return
            self.hit = hit
        started = time.monotonic()
        try:
            self._kill_all()
        finally:
            self.stop_seconds = time.monotonic() - started
            record = {**asdict(hit), 'status': 'STOPPED-PROVIDER', 'killSeconds': self.stop_seconds}
            self.evidence_dir.mkdir(parents=True, exist_ok=True)
            (self.evidence_dir / 'STOPPED-PROVIDER.json').write_text(json.dumps(record, indent=2) + '\n')
            # The global marker: no host starts anywhere until a person reviews
            # this run and deletes the marker (harness/README.md, "After a stop").
            self.stop_marker.parent.mkdir(parents=True, exist_ok=True)
            marker = {**record, 'evidence': str(self.evidence_dir)}
            self.stop_marker.write_text(json.dumps(marker, indent=2) + '\n')

    # Log files: followed by a thread so a hostname in a host log stops the run
    # within the same budget as one on screen.

    def follow(self, path: Path, source: str = 'host-log') -> None:
        with self._lock:
            self._files.setdefault(path, (source, 0))
        if self._thread is None:
            self._thread = threading.Thread(target=self._follow_loop, name='watchdog-files', daemon=True)
            self._thread.start()

    def poll_files(self) -> None:
        with self._lock:
            files = list(self._files.items())
        for path, (source, offset) in files:
            try:
                with path.open('rb') as handle:
                    handle.seek(offset)
                    data = handle.read()
            except FileNotFoundError:
                continue
            if not data:
                continue
            with self._lock:
                self._files[path] = (source, offset + len(data))
            self.scan(data.decode('utf-8', 'replace'), source, str(path), stream=True)

    def _follow_loop(self) -> None:
        while not self._closing.wait(0.1):
            self.poll_files()

    def close(self) -> None:
        self._closing.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        self.poll_files()

    def summary(self) -> dict:
        return {
            'stopped': self.stopped,
            'hit': asdict(self.hit) if self.hit else None,
            'killSeconds': self.stop_seconds,
            'helpMentions': [asdict(h) for h in self.help_mentions],
        }


def ensure_not_stopped(marker: Path | None = None) -> None:
    """Refuse to start any host while a STOPPED-PROVIDER marker awaits review."""
    marker = marker if marker is not None else paths.stop_marker()
    if marker.exists():
        raise ProviderStop(
            f'a previous run stopped on a real provider hostname ({marker}); '
            'a person must review its evidence and delete the marker before any host runs again'
        )

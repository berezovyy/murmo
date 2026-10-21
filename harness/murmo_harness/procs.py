"""Process bookkeeping for safety rule 11 (clean up).

A run registers every process it starts (host PTY children, tmux servers,
helpers, the fake server's thread lives in-process). While sessions are open a
thread samples the process table, so descendants are known even if they
later re-parent. A process belongs to the run when it descends from a
registered root, holds one of the run's terminals as its controlling tty, or
has one of the run's unique markers (its temp root, its tmux socket name) in
its command line. Nothing else is ever signalled.
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Proc:
    pid: int
    ppid: int
    pgid: int
    stat: str
    tty: str
    start: str
    command: str
    rss_kb: int = 0


def snapshot() -> dict[int, Proc]:
    """The current process table of this machine (or container)."""
    out = subprocess.run(
        ['ps', '-axww', '-o', 'pid=,ppid=,pgid=,rss=,stat=,tty=,lstart=,command='],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
        env={**os.environ, 'LC_ALL': 'C'},  # lstart in one fixed format
    ).stdout
    table: dict[int, Proc] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 11:
            continue
        # lstart is five words: "Tue Oct 21 12:55:04 2026".
        pid, ppid, pgid, rss = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
        stat, tty = parts[4], parts[5]
        start = ' '.join(parts[6:11])
        command = ' '.join(parts[11:])
        table[pid] = Proc(pid, ppid, pgid, stat, tty, start, command, rss)
    return table


def started_at(proc: Proc) -> float:
    """`lstart` as epoch seconds (one-second resolution)."""
    try:
        return time.mktime(time.strptime(proc.start, '%a %b %d %H:%M:%S %Y'))
    except ValueError:
        return 0.0


def tree_rss_kb(root: int, table: dict[int, Proc] | None = None) -> int:
    """Resident memory of `root` and all its descendants, in KiB."""
    table = table if table is not None else snapshot()
    members = {root} if root in table else set()
    changed = True
    while changed:
        changed = False
        for proc in table.values():
            if proc.pid not in members and proc.ppid in members:
                members.add(proc.pid)
                changed = True
    return sum(table[pid].rss_kb for pid in members)


def tty_name(path: str) -> str:
    """`/dev/ttys012` → `ttys012`, `/dev/pts/3` → `pts/3`: the form `ps` prints."""
    return path.removeprefix('/dev/')


@dataclass
class ProcessRegistry:
    """Owned processes of one run. Thread-safe."""

    roots: set[int] = field(default_factory=set)
    # Children this process forked itself (pty.fork); only these are reaped here,
    # never other children, whose waits belong to the subprocess module.
    forked: set[int] = field(default_factory=set)
    # A terminal is the run's from when it was registered until its session
    # was killed; the OS hands the same tty to someone else afterwards.
    ttys: dict[str, float] = field(default_factory=dict)
    markers: set[str] = field(default_factory=set)
    known: dict[int, Proc] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _sampler: threading.Thread | None = None
    _stop_sampling: threading.Event = field(default_factory=threading.Event)

    def register(self, pid: int, *, tty: str | None = None, forked: bool = False) -> None:
        with self._lock:
            self.roots.add(pid)
            if forked:
                self.forked.add(pid)
            if tty:
                self.ttys[tty_name(tty)] = time.time() - 1.0
        self.observe()

    def add_marker(self, marker: str) -> None:
        with self._lock:
            self.markers.add(marker)

    def _owned(self, table: dict[int, Proc]) -> dict[int, Proc]:
        own_pid = os.getpid()
        owned: dict[int, Proc] = {}
        with self._lock:
            roots, ttys, markers = set(self.roots), dict(self.ttys), set(self.markers)
            known = dict(self.known)
        for proc in table.values():
            if proc.pid == own_pid:
                continue
            if (
                proc.pid in roots
                or (proc.tty in ttys and proc.tty not in ('?', '??') and started_at(proc) >= ttys[proc.tty])
                or any(m in proc.command for m in markers)
                or (proc.pid in known and known[proc.pid].start == proc.start)
            ):
                owned[proc.pid] = proc
        # Descendants of anything owned (the table is a forest; iterate to a fixpoint).
        changed = True
        while changed:
            changed = False
            for proc in table.values():
                if proc.pid not in owned and proc.ppid in owned and proc.pid != own_pid:
                    owned[proc.pid] = proc
                    changed = True
        return owned

    def observe(self) -> dict[int, Proc]:
        """Sample the process table and remember every owned process."""
        owned = self._owned(snapshot())
        with self._lock:
            self.known.update(owned)
        return owned

    def alive(self) -> list[Proc]:
        """Owned processes still running (same pid and start time as when seen)."""
        table = snapshot()
        owned = self._owned(table)
        with self._lock:
            known = dict(self.known)
        alive = dict(owned)
        for pid, proc in known.items():
            current = table.get(pid)
            if current and current.start == proc.start:
                alive[pid] = current
        # A zombie we have not reaped yet is not a running process.
        return [p for p in alive.values() if not p.stat.startswith('Z')]

    def start_sampling(self, interval: float = 0.25) -> None:
        if self._sampler is not None:
            return
        self._stop_sampling.clear()

        def loop() -> None:
            while not self._stop_sampling.wait(interval):
                try:
                    self.observe()
                except (OSError, subprocess.SubprocessError):
                    pass

        self._sampler = threading.Thread(target=loop, name='process-sampler', daemon=True)
        self._sampler.start()

    def stop_sampling(self) -> None:
        self._stop_sampling.set()
        if self._sampler is not None:
            self._sampler.join(timeout=2)
            self._sampler = None

    def kill_all(self, grace: float = 0.4) -> list[Proc]:
        """SIGTERM every owned process (and its group), then SIGKILL what is left.
        Returns what is still alive afterwards (should be empty)."""
        return self._kill(lambda _proc, _owned: True, grace)

    def kill_session(self, root: int, tty: str | None = None, grace: float = 0.4) -> list[Proc]:
        """Kill one session's tree: `root`, its descendants, and anything on its terminal."""
        tty = tty_name(tty) if tty else None

        def in_session(proc: Proc, owned: dict[int, Proc]) -> bool:
            if proc.pid == root or (tty and proc.tty == tty):
                return True
            parent = owned.get(proc.ppid)
            seen = set()
            while parent is not None and parent.pid not in seen:
                if parent.pid == root:
                    return True
                seen.add(parent.pid)
                parent = owned.get(parent.ppid)
            return False

        left = self._kill(in_session, grace)
        if tty and not left:
            with self._lock:
                self.ttys.pop(tty, None)
        return left

    def _kill(self, select, grace: float) -> list[Proc]:
        # Only live processes are signalled: `observe` matches remembered pids
        # by start time too, so a reused pid is never mistaken for ours.
        owned = self.observe()
        chosen = {pid for pid, proc in owned.items() if select(proc, owned)}

        def remaining() -> list[Proc]:
            return [p for p in self.alive() if p.pid in chosen]

        _signal_all([owned[pid] for pid in chosen], signal.SIGTERM)
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            self.reap()
            if not remaining():
                break
            time.sleep(0.03)
        left = remaining()
        if left:
            _signal_all(left, signal.SIGKILL)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                self.reap()
                left = remaining()
                if not left:
                    break
                time.sleep(0.03)
        self.reap()
        return remaining()

    def reap(self) -> None:
        """Collect exited children this process forked, so they do not linger as zombies."""
        with self._lock:
            forked = set(self.forked)
        for pid in forked:
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                done = pid
            if done:
                with self._lock:
                    self.forked.discard(pid)


def _signal_all(procs, sig: int) -> None:
    own_group = os.getpgrp()
    for proc in procs:
        # A host's own process group (pty.fork makes it a session leader): one
        # signal reaches children that are between ps samples.
        if proc.pgid > 1 and proc.pgid != own_group:
            try:
                os.killpg(proc.pgid, sig)
            except (ProcessLookupError, PermissionError):
                pass
        try:
            os.kill(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

"""Latency under load, against a same-run control (lesson 65).

Two arms of the same host and version run side by side in one run: the
control (stock, no Murmo) and the test (the integration under test). Trials
alternate between the arms, flipping the order every trial, so CPU noise
lands on both. Each trial types a unique marker key by key and times the last
key's write to the first frame that shows the marker plus the full draft
prefix with the cursor right after it, timed by the PTY reader (no tmux
polling). The CPU quota itself comes from the container (`--cpus`, pinned
cpusets); concurrent sessions and a busy neighbour add pressure inside it.

With only stock hosts (before phases 21–24) both arms are stock: the numbers
are the host's own floor under the quota, which later adapter runs compare to.
"""

from __future__ import annotations

import statistics
import subprocess
import sys
import time

from .integrations import STOCK, Integration
from .procs import tree_rss_kb
from .session import Run, Session

PREFIX = 'load '
FRAME_TIMEOUT = 5.0
NEIGHBOUR = 'import time\nwhile True:\n    sum(i * i for i in range(10000))\n'


def marker(trial: int) -> str:
    return f'q{trial:03d}z'


def _quantile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))
    return round(ordered[index], 2)


def _trial(session: Session, trial: int) -> float | None:
    if not session.clear():
        return None
    word = marker(trial)
    want = PREFIX + word
    session.type(want[:-1], delay=0.02)
    session.driver.settle(quiet=0.15, timeout=3)

    def shows(screen) -> bool:
        draft = session.host.read_draft(screen, session.placeholder)
        if draft is None or draft.rstrip() != want:
            return False
        # The cursor sits right after the marker on its row.
        row = screen.row(screen.cursor[1])
        return row[: screen.cursor[0]].rstrip().endswith(word)

    return session.driver.time_to_frame(lambda: session.driver.write(want[-1]), shows, FRAME_TIMEOUT)


def measure(run: Run, host: str, install, *, trials: int, integration: Integration = STOCK,
            sessions: int = 1, neighbour: bool = False) -> dict:
    """Interleaved control/test trials; `sessions` extra idle sessions per arm."""
    helpers: list[subprocess.Popen] = []
    arms: dict[str, Session] = {}
    extra: list[Session] = []
    result: dict = {'host': host, 'version': install.version, 'trials': trials, 'sessions': sessions,
                    'neighbour': neighbour, 'arms': {}}
    try:
        if neighbour:
            proc = subprocess.Popen([sys.executable, '-I', '-c', NEIGHBOUR], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            run.registry.register(proc.pid)
            helpers.append(proc)
        arms['control'] = run.open_session(host, install, integration=STOCK, label='control')
        arms['test'] = run.open_session(host, install, integration=integration, label='test')
        for n in range(max(0, sessions - 1)):
            extra.append(run.open_session(host, install, integration=STOCK, label=f'idle{n}'))
        samples: dict[str, list[float | None]] = {'control': [], 'test': []}
        for trial in range(trials):
            order = ('control', 'test') if trial % 2 == 0 else ('test', 'control')
            for arm in order:
                samples[arm].append(_trial(arms[arm], trial))
        for arm, values in samples.items():
            got = [v for v in values if v is not None]
            root = arms[arm].driver.root_pid()
            result['arms'][arm] = {
                'integration': arms[arm].integration.name,
                'n': len(values),
                'misses': len(values) - len(got),
                'p50Ms': _quantile(got, 0.5),
                'p95Ms': _quantile(got, 0.95),
                'meanMs': round(statistics.fmean(got), 2) if got else None,
                'rssKb': tree_rss_kb(root) if root else None,
                'startupSeconds': round(arms[arm].startup_seconds or 0, 2),
                'samplesMs': [None if v is None else round(v, 2) for v in values],
            }
        c, t = result['arms']['control'], result['arms']['test']
        if c['p50Ms'] and t['p50Ms']:
            result['testOverControlP50'] = round(t['p50Ms'] / c['p50Ms'], 3)
        result['passed'] = all(a['misses'] == 0 for a in result['arms'].values())
    finally:
        for session in [*extra, *arms.values()]:
            session.close()
        for proc in helpers:
            run.registry.kill_session(proc.pid)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
    return result

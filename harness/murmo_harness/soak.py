"""Soak driver (phase 29 runs the full 20 minutes and 2,000 words).

Ported from the round 13 installed soak: words go in at a steady pace, each
one a unique token (`w03a`), so the oracle is exact: after every word the
draft must end with everything typed since the last clear, and a missing or
doubled word cannot hide behind a similar one. Every 100 words the
integration's per-plugin state is read and any disabled plugin is reported,
whatever the session says about its health (lessons 71, 76). Every 10 words
the draft is cleared, so it never grows past one screen line.
"""

from __future__ import annotations

import time

from . import evidence
from .integrations import Integration
from .session import Run

CLEAR_EVERY = 10
STATE_EVERY = 100
ON_TIME_SECONDS = 0.35  # round 13: a screen later than this is "late", not missing
MISS_SECONDS = 2.0


def token(i: int) -> str:
    return f'w{i:03x}'


def soak(run: Run, host: str, install, *, words: int, minutes: float, integration: Integration,
         driver: str, attempt) -> dict:
    session = run.open_session(host, install, driver=driver, integration=integration, label='soak')
    row = {
        'host': host, 'version': install.version, 'driver': driver, 'integration': integration.name,
        'words': 0, 'late': [], 'misses': [], 'stateChecks': [], 'disabledSeen': [], 'status': 'running',
    }
    pace = (minutes * 60) / max(words, 1)
    start = time.monotonic()
    expected = ''
    try:
        for i in range(words):
            deadline = start + i * pace
            while time.monotonic() < deadline:
                run.watchdog.check()
                time.sleep(min(0.01, max(0.0, deadline - time.monotonic())))
            if i % CLEAR_EVERY == 0:
                if not session.clear():
                    row['misses'].append({'word': i, 'what': 'clear failed', 'draft': session.draft()})
                expected = ''
            word = token(i)
            session.type(word + ' ', delay=0.01)
            expected += word + ' '
            want = expected.rstrip()

            def shows(screen, want=want) -> bool:
                draft = session.host.read_draft(screen, session.placeholder)
                return draft is not None and draft.rstrip() == want

            on_time = session.driver.wait(shows, ON_TIME_SECONDS)
            if not on_time:
                row['late'].append(i)
                if not session.driver.wait(shows, MISS_SECONDS):
                    row['misses'].append({'word': i, 'expected': want, 'draft': session.draft()})
                    session.save(attempt / 'misses', f'word-{i:04d}')
                    session.clear()
                    expected = ''
            row['words'] += 1
            if i % STATE_EVERY == STATE_EVERY - 1:
                state = integration.state(session.host, session.profile).as_dict()
                row['stateChecks'].append({'word': i + 1, 'seconds': round(time.monotonic() - start, 1),
                                           'healthy': state['healthy'], 'disabled': state['disabled']})
                if state['disabled']:
                    row['disabledSeen'].append({'word': i + 1, 'disabled': state['disabled']})
                evidence.write_json(attempt / 'soak-progress.json', row)
        # Hold the session open for the rest of the soak time (idle drift, timers).
        while time.monotonic() - start < minutes * 60:
            run.watchdog.check()
            time.sleep(0.05)
        session.save(attempt, 'soak-final')
        row['status'] = 'complete'
    finally:
        row['seconds'] = round(time.monotonic() - start, 1)
        session.close()
    row['passed'] = row['status'] == 'complete' and not row['misses'] and not row['disabledSeen']
    return row

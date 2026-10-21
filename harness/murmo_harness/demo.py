"""Demo recorder: a scripted tmux run captured as ANSI panes, written as an
asciinema v2 cast (`docs` and phase 31 render it to video with any cast
player; rendering itself is phase 31's).

Each frame is `capture-pane -p -e` of the private tmux server, taken after
every step settles, so the cast shows exactly what a user would see. Frames
are stored as full redraws (clear + home + pane), which every cast player
plays back.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from .integrations import STOCK, Integration
from .session import Run

DEFAULT_SCRIPT = [
    {'type': 'murmo demo: a typed line'},
    {'pause': 0.8},
    {'key': 'Newline'},
    {'type': 'and a second line'},
    {'pause': 1.2},
]


class Recorder:
    def __init__(self, cols: int, rows: int, title: str) -> None:
        self.cols, self.rows, self.title = cols, rows, title
        self.start = time.monotonic()
        self.frames: list[tuple[float, str]] = []
        self._last = ''

    def frame(self, ansi: str) -> None:
        if ansi == self._last:
            return
        self._last = ansi
        body = ansi.rstrip('\n').replace('\n', '\r\n')
        self.frames.append((round(time.monotonic() - self.start, 3), '\x1b[2J\x1b[H' + body))

    def write(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        header = {'version': 2, 'width': self.cols, 'height': self.rows, 'title': self.title,
                  'env': {'TERM': 'xterm-256color'}}
        with path.open('w', encoding='utf-8') as handle:
            handle.write(json.dumps(header) + '\n')
            for stamp, data in self.frames:
                handle.write(json.dumps([stamp, 'o', data], ensure_ascii=False) + '\n')


def record(run: Run, host: str, install, out: Path, *, script: list[dict] | None = None,
           integration: Integration = STOCK, cols: int = 100, rows: int = 30) -> dict:
    session = run.open_session(host, install, driver='tmux', integration=integration, cols=cols, rows=rows, label='demo')
    recorder = Recorder(cols, rows, f'{host} {install.version}')
    try:
        recorder.frame(session.driver.ansi().decode('utf-8', 'replace'))
        for step in script or DEFAULT_SCRIPT:
            if 'type' in step:
                for ch in step['type']:
                    session.type(ch, delay=0)
                    time.sleep(0.06)
                    recorder.frame(session.driver.ansi().decode('utf-8', 'replace'))
            elif 'key' in step:
                session.driver.key(step['key'])
            elif 'pause' in step:
                session.driver.drain(step['pause'])
            session.driver.settle(quiet=0.2, timeout=3)
            recorder.frame(session.driver.ansi().decode('utf-8', 'replace'))
    finally:
        session.close()
    recorder.write(out)
    return {'cast': str(out), 'frames': len(recorder.frames), 'seconds': recorder.frames[-1][0] if recorder.frames else 0}

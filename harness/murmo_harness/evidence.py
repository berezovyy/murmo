"""Run outputs: `harness/out/<suite>/<host>/<attempt>/`, newest 3 kept.

AGENTS.md keeps only the last 3 attempts of a measurement; numbers that
matter go into docs/knowledge.md before older attempts are deleted. Same
naming as `tools/runs.mjs` (ISO timestamps sort by time as plain strings).
"""

from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path

from . import paths

KEEP = 3
_NAME = re.compile(r'^[a-z0-9][a-z0-9._-]*$')


def new_attempt(suite: str, host: str, *, base: Path | None = None, now: float | None = None) -> Path:
    for part in (suite, host):
        if not _NAME.match(part):
            raise ValueError(f'bad measurement name part {part!r}')
    folder = (base or paths.OUT) / suite / host
    folder.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime('%Y-%m-%dT%H-%M-%S', time.gmtime(now if now is not None else time.time()))
    attempt = folder / stamp
    n = 2
    while attempt.exists():
        attempt = folder / f'{stamp}-{n}'
        n += 1
    attempt.mkdir()
    prune(folder)
    return attempt


def attempts(folder: Path) -> list[Path]:
    return sorted((p for p in folder.iterdir() if p.is_dir()), key=lambda p: p.name)


def prune(folder: Path, keep: int = KEEP) -> list[Path]:
    old = attempts(folder)[:-keep]
    for path in old:
        shutil.rmtree(path, ignore_errors=True)
    return old


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str) + '\n')


def append_jsonl(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as handle:
        handle.write(json.dumps(row, ensure_ascii=False, default=str) + '\n')


# Cargo writes these into every target directory it builds into. A folder
# that is merely named `target` (the `cc` crate has a `src/target` module;
# an installed package can ship `target/release/<bin>`) is not a build cache.
CARGO_TARGET_MARKERS = ('CACHEDIR.TAG', '.rustc_info.json')


def stray_targets(root: Path = paths.REPO) -> list[str]:
    """Cargo target folders inside the checkout (AGENTS.md: builds use the shared cache)."""
    found = []
    for path in root.rglob('target'):
        if 'node_modules' in path.parts or '.git' in path.parts or not path.is_dir():
            continue
        if any((path / marker).exists() for marker in CARGO_TARGET_MARKERS):
            found.append(str(path.relative_to(root)))
    return sorted(found)

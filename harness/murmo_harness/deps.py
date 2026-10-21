"""pyte, the one third-party dependency, from the harness cache's venv.

The harness runs with `python3 -I`, which ignores PYTHONPATH, so the venv's
site-packages (or, inside the Linux container, the read-only mount named by
MURMO_HARNESS_PYLIB) is added to sys.path here. pyte and wcwidth are pure
Python, so one copy serves macOS and the container's Python alike.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from . import paths


def site_packages(venv: Path) -> Path | None:
    for candidate in sorted((venv / 'lib').glob('python3*/site-packages')):
        return candidate
    return None


def ensure_pyte():
    """Import pyte or explain how to install it."""
    try:
        import pyte  # noqa: F401
    except ImportError:
        extra = os.environ.get('MURMO_HARNESS_PYLIB')
        candidates = [Path(extra)] if extra else []
        found = site_packages(paths.python_venv_dir())
        if found:
            candidates.append(found)
        for path in candidates:
            if (path / 'pyte').is_dir() and str(path) not in sys.path:
                sys.path.append(str(path))
        try:
            import pyte  # noqa: F401
        except ImportError:
            raise RuntimeError(
                'pyte is not installed in the harness cache; run `pnpm harness install python` first'
            ) from None
    import pyte

    return pyte

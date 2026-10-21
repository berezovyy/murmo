"""Murmo real-host harness. Read harness/README.md (the safety rules) first.

Run with `pnpm harness <command>` or `python3 -I harness/harness.py <command>`.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True

from murmo_harness.cli import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())

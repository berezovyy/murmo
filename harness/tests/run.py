"""`pnpm test:harness`: the harness's own tests (unittest, stdlib only).

Runs unsandboxed itself, because macOS cannot nest sandbox-exec: every host
process the tests start is sandboxed by the harness, as in a real run.
"""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
sys.dont_write_bytecode = True

if __name__ == '__main__':
    pattern = sys.argv[1] if len(sys.argv) > 1 else 'test_*.py'
    suite = unittest.defaultTestLoader.discover(str(HERE), pattern=pattern, top_level_dir=str(HERE))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)

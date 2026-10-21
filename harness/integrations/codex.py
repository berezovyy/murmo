"""Phase 23: wrap stock Codex in `murmo-codex`. The pre-launch check still
requires the rule 4 flags on the *final* command line (lessons 44, 53).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from murmo_harness.integrations import Integration, IntegrationState
from murmo_harness.paths import REPO, main_checkout


def wrapper_bin() -> Path:
    env = os.environ.get('MURMO_CODEX_WRAPPER')
    if env:
        return Path(env)
    target = Path(
        os.environ.get(
            'CARGO_TARGET_DIR',
            str(main_checkout() / 'experiments' / '.cache' / 'cargo-target' / 'murmo'),
        )
    )
    debug = target / 'debug' / 'murmo-codex'
    release = target / 'release' / 'murmo-codex'
    if release.is_file():
        return release
    return debug


class CodexMurmo(Integration):
    name = 'codex'
    features = frozenset({'inline', 'submit-guard', 'owned-undo', 'tracked-draft'})

    def argv(self, host, install, profile, argv: list[str]) -> list[str]:
        wrap = wrapper_bin()
        if not wrap.is_file():
            return argv
        # Keep the stock argv (including -c model_provider=…) after the wrapper.
        return [str(wrap), *argv]

    def logs(self, host, profile) -> list[Path]:
        trace = Path(os.environ.get('MURMO_TRACE', ''))
        return [trace] if trace.is_file() else []

    def capabilities(self, host, profile) -> dict | None:
        path = REPO / 'packages' / 'fake-host' / 'records' / 'codex.json'
        if not path.is_file():
            return None
        return json.loads(path.read_text())

    def state(self, host, profile) -> IntegrationState:
        return IntegrationState(healthy=None, plugins=[], notices=[])


INTEGRATION = CodexMurmo()

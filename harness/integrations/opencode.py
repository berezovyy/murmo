"""Phase 22 OpenCode adapter integration.

Registers `@murmo/adapter-opencode` as a V2 TUI plugin through public
`cli.json`. Frozen physical `tui.js` is phase 26; until then the workspace
`./tui` export is the entry. Real-host bursts, soaks and native-UI cases
still run only through this harness (fake model, network blocked, throwaway
HOME).
"""

from __future__ import annotations

import json
from pathlib import Path

from murmo_harness.integrations import Integration, IntegrationState
from murmo_harness.paths import REPO


class OpenCodeMurmo(Integration):
    name = 'opencode-adapter'
    features = frozenset({'adapter.opencode', 'adapter.rescue', 'core.inline', 'plugin.shortcuts'})

    def prepare(self, host, profile) -> None:
        if host.name != 'opencode':
            return
        package = REPO / 'packages' / 'adapters' / 'opencode'
        cli = profile.opencode_config_dir / 'cli.json'
        cli.parent.mkdir(parents=True, exist_ok=True)
        cli.write_text(json.dumps({'plugins': [str(package)]}, indent=2))

    def logs(self, host, profile) -> list[Path]:
        log = Path(profile.home) / 'murmo-opencode.jsonl'
        return [log] if log.exists() else []

    def capabilities(self, host, profile) -> dict | None:
        if host.name != 'opencode':
            return None
        return {
            'inputOriginEvidence': 'host-labeled',
            'ui.dialogSafe': False,
            'submit.committed': 'accepted-text',
            'inlineRewrite': 'same-transaction',
            'keyPriority': 'unknown',
        }


INTEGRATION = OpenCodeMurmo()

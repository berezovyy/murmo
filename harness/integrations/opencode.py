"""OpenCode adapter integration from the workspace.

Links `@murmo/adapter-opencode` into `<config>/plugins/murmo`, the folder
`murmo setup` links the packed package into (`linkOpenCodePlugin` in
packages/cli/src/hosts.ts), so workspace runs load Murmo the way users get
it; its `./tui` export is the entry. Real-host bursts, soaks and native-UI
cases still run only through this harness (fake model, network blocked,
throwaway HOME).
"""

from __future__ import annotations

import os
from pathlib import Path

from murmo_harness.integrations import Integration, IntegrationState
from murmo_harness.paths import REPO


def link_plugin(config_dir: Path, package: Path) -> Path:
    """`<config>/plugins/murmo` -> `package`, replacing an earlier link of ours."""
    folder = config_dir / 'plugins'
    folder.mkdir(parents=True, exist_ok=True)
    link = folder / 'murmo'
    if link.is_symlink():
        link.unlink()
    elif link.exists():
        raise RuntimeError(f'{link} exists and is not a link; the profile is not a fresh one')
    os.symlink(package, link, target_is_directory=True)
    return link


class OpenCodeMurmo(Integration):
    name = 'opencode-adapter'
    features = frozenset({'adapter.opencode', 'adapter.rescue', 'core.inline', 'plugin.shortcuts'})

    def prepare(self, host, profile, run=None) -> None:
        if host.name != 'opencode':
            return
        link_plugin(profile.opencode_config_dir, REPO / 'packages' / 'adapters' / 'opencode')

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

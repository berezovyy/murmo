"""OpenCode (`@opencode/cli`): a Bun-compiled binary in the platform package.

Isolation needs more than HOME (lesson 53): OpenCode searched every parent
folder for `.claude/skills` and `.agents/skills` and read real-home skills in
round 11, so profiles set OPENCODE_CONFIG_PROJECT_DISABLE,
OPENCODE_DISABLE_CLAUDE_CODE_SKILLS and an explicit OPENCODE_CONFIG. It also
creates data, log, cache and state folders even for `--version` (r10 I1), so
version probes run in a throwaway profile like any launch.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .. import safety
from ..profile import Profile
from ..screen import ScreenView
from .base import HostProfile, Install

PROVIDER = 'murmo-fake'
MODEL = 'fake'
_BUN = re.compile(rb'Bun v(\d+\.\d+\.\d+)')


class OpenCodeHost(HostProfile):
    name = 'opencode'
    package = '@opencode/cli'
    route = 'chat'

    def entry(self, install_dir: Path, platform: str) -> tuple[str, ...]:
        return (f'node_modules/@opencode/cli-{platform}/bin/opencode',)

    def write_config(self, profile: Profile) -> None:
        config = {
            'model': f'{PROVIDER}/{MODEL}',
            'providers': {
                PROVIDER: {
                    'package': '@opencode/ai/providers/openai-compatible',
                    'settings': {'apiKey': safety.FAKE_KEY, 'baseURL': profile.fake_v1},
                    'models': {MODEL: {'name': 'Murmo fake', 'limit': {'context': 128000, 'output': 1024}, 'cost': {'input': 0, 'output': 0}}},
                }
            },
        }
        profile.opencode_config.write_text(json.dumps(config, indent=2))
        (profile.opencode_config_dir / 'cli.json').write_text(json.dumps({'plugins': []}))

    def check_config(self, profile: Profile, argv: list[str]) -> dict[str, bool]:
        env = profile.env
        try:
            config = json.loads(profile.opencode_config.read_text())
        except (OSError, ValueError):
            return {'config-readable': False}
        providers = config.get('providers', {})
        settings = [p.get('settings', {}) for p in providers.values()]
        return {
            'config-readable': True,
            'explicit-config': env.get('OPENCODE_CONFIG') == str(profile.opencode_config),
            'project-config-disabled': env.get('OPENCODE_CONFIG_PROJECT_DISABLE') == 'true',
            'claude-skills-disabled': env.get('OPENCODE_DISABLE_CLAUDE_CODE_SKILLS') == 'true',
            'only-fake-provider': list(providers) == [PROVIDER],
            'provider-loopback': all(safety.loopback_url(s.get('baseURL', '')) for s in settings),
            'provider-key-fake': all(s.get('apiKey') == safety.FAKE_KEY for s in settings),
            'model-is-fake': config.get('model') == f'{PROVIDER}/{MODEL}',
        }

    def launch_argv(self, install: Install, profile: Profile) -> list[str]:
        return [*install.argv(), '--standalone']

    def bundled_bun(self, install: Install) -> str | None:
        """The Bun the binary was compiled with (phase 01 pins against it),
        read from the `Bun vX.Y.Z` string in the executable, without running it."""
        found = None
        tail = b''
        with install.binary().open('rb') as handle:
            while chunk := handle.read(1 << 22):
                match = _BUN.search(tail + chunk)
                if match:
                    found = match.group(1).decode()
                    break
                tail = chunk[-32:]
        return found

    auxiliary_markers = ('You are a title generator',)

    def _box(self, screen: ScreenView) -> tuple[int, int, int] | None:
        """(left column, first row, agent row) of the input box: the rows that
        start with `┃` above the last `╹▀▀` edge; the last of them is the agent line."""
        bottoms = [y for y, line in enumerate(screen.lines) if line.lstrip().startswith('╹▀')]
        if not bottoms:
            return None
        bottom = bottoms[-1]
        left = screen.row(bottom).index('╹')
        agent = bottom - 1
        if screen.row(agent)[left : left + 1] != '┃':
            return None
        first = agent
        while first > 0 and screen.row(first - 1)[left : left + 1] == '┃':
            first -= 1
        return left, first, agent

    def ready(self, screen: ScreenView) -> bool:
        box = self._box(screen)
        return box is not None and MODEL in screen.row(box[2])

    def prompt_rows(self, screen: ScreenView) -> list[str] | None:
        # `┃  ` then the draft, padded by an empty `┃` row above and below (2.0.32–2.1.2).
        box = self._box(screen)
        if box is None:
            return None
        left, first, agent = box
        return [screen.row(y)[left + 3 :] for y in range(first, agent)]

    def read_draft(self, screen: ScreenView, placeholder: str | None = None) -> str | None:
        text = super().read_draft(screen, placeholder)
        # The empty box shows `Ask anything… "<example>"`.
        if text is not None and text.startswith('Ask anything… "') and text.endswith('"'):
            return ''
        return text

    def mode(self, screen: ScreenView) -> str:
        box = self._box(screen)
        if box is None:
            return 'no-prompt'
        if screen.row(box[2])[box[0] + 3 :].strip().lower().startswith('shell'):
            return 'shell'
        return super().mode(screen)

    def canary_screen(self, screen: ScreenView, version: str) -> dict[str, bool]:
        box = self._box(screen)
        agent = screen.row(box[2]) if box else ''
        return {
            'input-box': box is not None,
            # The agent line names the fake model: OpenCode read our OPENCODE_CONFIG.
            'agent-line-fake-model': 'Murmo fake' in agent and MODEL in agent,
            'home-version': any(line.strip() == version for line in screen.lines),
        }

"""Codex CLI (`@openai/codex`): the npm launcher starts the native binary.

Safety rule 4 lives here: a provider in plain `config.toml` is not forwarded
at thread start, and stock Codex once switched itself to api.openai.com
(lessons 44, 53), so every launch passes `-c model_provider=…`,
`-c openai_base_url=…` and the whole `model_providers.murmo_local.*` table on
the command line. Phase 23's `murmo codex` wrapper plugs in through the
integration seam and must keep these flags.
"""

from __future__ import annotations

import json
import tomllib
from pathlib import Path

from .. import safety
from ..profile import Profile
from ..screen import ScreenView
from .base import HostProfile, Install

PROVIDER = 'murmo_local'
MODEL = 'murmo-fake'


def provider_flags(profile: Profile) -> list[str]:
    """The rule 4 flags, in the form `-c key=<TOML value>`."""
    pairs = [
        ('model_provider', json.dumps(PROVIDER)),
        ('model', json.dumps(MODEL)),
        ('openai_base_url', json.dumps(profile.fake_v1)),
        (f'model_providers.{PROVIDER}.name', json.dumps('Murmo fake')),
        (f'model_providers.{PROVIDER}.base_url', json.dumps(profile.fake_v1)),
        (f'model_providers.{PROVIDER}.wire_api', json.dumps('responses')),
        (f'model_providers.{PROVIDER}.requires_openai_auth', 'false'),
        (f'model_providers.{PROVIDER}.env_key', json.dumps('MURMO_FAKE_KEY')),
        (f'model_providers.{PROVIDER}.request_max_retries', '0'),
        (f'model_providers.{PROVIDER}.stream_max_retries', '0'),
    ]
    flags: list[str] = []
    for key, value in pairs:
        flags += ['-c', f'{key}={value}']
    return flags


class CodexHost(HostProfile):
    name = 'codex'
    package = '@openai/codex'
    route = 'responses'
    gestures = {'send': 'Enter', 'newline': 'Newline', 'queue': 'Tab'}

    def entry(self, install_dir: Path, platform: str) -> tuple[str, ...]:
        package_dir = install_dir / 'node_modules' / self.package
        manifest = json.loads((package_dir / 'package.json').read_text())
        return ('node', str((package_dir / manifest['bin']['codex']).relative_to(install_dir)))

    def write_config(self, profile: Profile) -> None:
        v1 = profile.fake_v1
        config = f'''# Written by the murmo harness. The provider is repeated on the command line (rule 4).
model = "{MODEL}"
model_provider = "{PROVIDER}"
openai_base_url = "{v1}"
check_for_update_on_startup = false

[model_providers.{PROVIDER}]
name = "Murmo fake"
base_url = "{v1}"
wire_api = "responses"
requires_openai_auth = false
env_key = "MURMO_FAKE_KEY"
request_max_retries = 0
stream_max_retries = 0

[history]
persistence = "none"

[analytics]
enabled = false

[feedback]
enabled = false

# Plugins sync the curated marketplace from github.com/openai/plugins at start
# (blocked by the sandbox, but a network attempt all the same).
[features]
plugins = false
remote_plugin = false
plugin_sharing = false

[projects."{profile.project}"]
trust_level = "trusted"

[tui]
terminal_title = ["run-state"]
screen_reader_detection_done = true
'''
        (profile.codex_home / 'config.toml').write_text(config)

    def check_config(self, profile: Profile, argv: list[str]) -> dict[str, bool]:
        try:
            config = tomllib.loads((profile.codex_home / 'config.toml').read_text())
        except (OSError, tomllib.TOMLDecodeError):
            return {'config-readable': False}
        providers = config.get('model_providers', {})
        joined = '\n'.join(argv)
        return {
            'config-readable': True,
            'config-provider': config.get('model_provider') == PROVIDER,
            'config-providers-loopback': all(safety.loopback_url(p.get('base_url', '')) for p in providers.values()),
            'config-openai-base-loopback': safety.loopback_url(config.get('openai_base_url', '')),
            'config-no-update-check': config.get('check_for_update_on_startup') is False,
            'config-history-none': config.get('history', {}).get('persistence') == 'none',
            'config-analytics-off': config.get('analytics', {}).get('enabled') is False,
            'config-feedback-off': config.get('feedback', {}).get('enabled') is False,
            # Rule 4, on the command line itself:
            'argv-model-provider': f'model_provider={json.dumps(PROVIDER)}' in joined,
            'argv-openai-base-url': f'openai_base_url={json.dumps(profile.fake_v1)}' in joined,
            'argv-provider-base-url': f'model_providers.{PROVIDER}.base_url={json.dumps(profile.fake_v1)}' in joined,
        }

    def launch_argv(self, install: Install, profile: Profile) -> list[str]:
        return [*install.argv(), '--no-alt-screen', *provider_flags(profile)]

    # Rule 4 holds for every Codex command, probes included.
    def version_argv(self, install: Install, profile: Profile) -> list[str]:
        return [*install.argv(), *provider_flags(profile), '--version']

    def help_argv(self, install: Install, profile: Profile) -> list[str]:
        return [*install.argv(), *provider_flags(profile), '--help']

    # Placeholders of the empty composer; the session also remembers the one
    # it saw when ready, since Codex picks from a rotating list.
    placeholders = ('Ask Codex to do anything', 'Find and fix a bug in @filename', 'Improve documentation in @filename')
    auxiliary_markers = ('Generate a concise, single-line task title',)
    known_attempts = {
        # 0.162–0.163 fetch openai/codex/main/announcement_tip.toml at TUI start;
        # no config or env switch turns it off. The trap refuses it.
        'raw.githubusercontent.com:443': 'Codex startup announcement tip (not a provider)',
    }

    def _composer(self, screen: ScreenView) -> int | None:
        rows = [y for y, line in enumerate(screen.lines) if line.startswith('› ') or line.rstrip() == '›']
        return rows[-1] if rows else None

    def ready(self, screen: ScreenView) -> bool:
        return self._composer(screen) is not None and screen.title == 'Ready'

    def prompt_rows(self, screen: ScreenView) -> list[str] | None:
        # `› ` then the draft; continuation rows are indented by two columns,
        # and a blank row separates the composer from the footer (0.162–0.163).
        top = self._composer(screen)
        if top is None:
            return None
        rows = [screen.row(top)[2:]]
        for y in range(top + 1, len(screen.lines)):
            line = screen.row(y)
            if not line.startswith('  ') or not line.strip():
                break
            rows.append(line[2:])
        return rows

    def busy(self, screen: ScreenView) -> bool:
        # The OSC title run-state is the busy signal; `Starting` is MCP startup (lesson 54).
        return screen.title != 'Ready'

    def canary_screen(self, screen: ScreenView, version: str) -> dict[str, bool]:
        return {
            'header-version': f'OpenAI Codex (v{version})' in screen.text,
            'composer-prompt-line': self._composer(screen) is not None,
            'footer-fake-model': any(line.strip().startswith(f'{MODEL} ') for line in screen.lines),
            'title-run-state': screen.title == 'Ready',
        }

    def paste(self, driver, text: str) -> None:
        # Codex reads 1,024 bytes at a time with edge-triggered epoll, so more
        # at once can stick until the next key (lesson 54): 800-byte writes.
        driver.paste(text, chunk=800)

"""Pi (`@earendil-works/pi-coding-agent`): a Node CLI with an OpenAI-compatible
provider configured in `models.json`."""

from __future__ import annotations

import json
from pathlib import Path

from .. import safety
from ..profile import Profile
from ..screen import ScreenView
from .base import HostProfile, Install, framed_rows

PROVIDER = 'murmo-local'
MODEL = 'murmo-fake'


class PiHost(HostProfile):
    name = 'pi'
    package = '@earendil-works/pi-coding-agent'
    route = 'chat'

    def entry(self, install_dir: Path, platform: str) -> tuple[str, ...]:
        package_dir = install_dir / 'node_modules' / self.package
        manifest = json.loads((package_dir / 'package.json').read_text())
        bin_path = manifest['bin']['pi'] if isinstance(manifest['bin'], dict) else manifest['bin']
        return ('node', str((package_dir / bin_path).relative_to(install_dir)))

    def write_config(self, profile: Profile) -> None:
        models = {
            'providers': {
                PROVIDER: {
                    'baseUrl': profile.fake_v1,
                    'api': 'openai-completions',
                    'apiKey': safety.FAKE_KEY,
                    'models': [
                        {
                            'id': MODEL,
                            'name': 'Murmo fake',
                            'reasoning': False,
                            'input': ['text'],
                            'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
                            'contextWindow': 128000,
                            'maxTokens': 1024,
                        }
                    ],
                }
            }
        }
        (profile.pi_dir / 'models.json').write_text(json.dumps(models, indent=2))
        settings = {'defaultProvider': PROVIDER, 'defaultModel': MODEL, 'quietStartup': True}
        (profile.pi_dir / 'settings.json').write_text(json.dumps(settings, indent=2))
        (profile.pi_dir / 'auth.json').write_text('{}')

    def check_config(self, profile: Profile, argv: list[str]) -> dict[str, bool]:
        try:
            models = json.loads((profile.pi_dir / 'models.json').read_text())
            settings = json.loads((profile.pi_dir / 'settings.json').read_text())
            auth = json.loads((profile.pi_dir / 'auth.json').read_text())
        except (OSError, ValueError):
            return {'config-readable': False}
        providers = models.get('providers', {})
        return {
            'config-readable': True,
            'only-fake-provider': list(providers) == [PROVIDER],
            'provider-loopback': all(safety.loopback_url(p.get('baseUrl', '')) for p in providers.values()),
            'provider-url-is-ours': all(p.get('baseUrl') == profile.fake_v1 for p in providers.values()),
            'provider-key-fake': all(p.get('apiKey') == safety.FAKE_KEY for p in providers.values()),
            'default-provider': settings.get('defaultProvider') == PROVIDER,
            'no-stored-credentials': auth == {},
            'offline-flag': '--offline' in argv,
        }

    def launch_argv(self, install: Install, profile: Profile) -> list[str]:
        return [
            *install.argv(),
            '--offline',
            '--no-session',
            '--no-tools',
            '--no-extensions',
            '--no-skills',
            '--no-prompt-templates',
            '--no-themes',
            '--no-context-files',
        ]

    # `--offline` on every Pi command, probes included.
    def version_argv(self, install: Install, profile: Profile) -> list[str]:
        return [*install.argv(), '--offline', '--version']

    def help_argv(self, install: Install, profile: Profile) -> list[str]:
        return [*install.argv(), '--offline', '--help']

    def ready(self, screen: ScreenView) -> bool:
        return MODEL in screen.text and framed_rows(screen) is not None

    def prompt_rows(self, screen: ScreenView) -> list[str] | None:
        # The editor sits between two rule rows above the footer (1.2.0, 1.3.0).
        frame = framed_rows(screen)
        if frame is None:
            return None
        top, bottom = frame
        return list(screen.lines[top + 1 : bottom])

    def canary_screen(self, screen: ScreenView, version: str) -> dict[str, bool]:
        frame = framed_rows(screen)
        return {
            # The footer names the fake provider and model: Pi read our models.json.
            'footer-fake-model': f'({PROVIDER}) {MODEL}' in screen.text,
            'editor-framed': frame is not None,
            'cursor-in-editor': frame is not None and frame[0] < screen.cursor[1] < frame[1],
        }

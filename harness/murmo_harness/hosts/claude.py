"""Claude Code (`@anthropic-ai/claude-code`): a native binary in the platform
package, pointed at the fake server through ANTHROPIC_BASE_URL in the
environment and in its settings file."""

from __future__ import annotations

import json
from pathlib import Path

from .. import safety
from ..profile import Profile
from ..screen import ScreenView
from .base import HostProfile, Install, framed_rows


def _platform_package(platform: str) -> str:
    return f'@anthropic-ai/claude-code-{platform}'


class ClaudeHost(HostProfile):
    name = 'claude'
    package = '@anthropic-ai/claude-code'
    route = 'anthropic'
    key_delay = 0.08

    def entry(self, install_dir: Path, platform: str) -> tuple[str, ...]:
        return (f'node_modules/{_platform_package(platform)}/claude',)

    # --- config -----------------------------------------------------------

    def settings_path(self, profile: Profile) -> Path:
        return profile.claude_dir / 'settings.json'

    def state_files(self, profile: Profile) -> list[Path]:
        # With CLAUDE_CONFIG_DIR set Claude keeps `.claude.json` there; older
        # builds and `claude plugin install` have used $HOME/.claude.json.
        return [profile.claude_dir / '.claude.json', profile.home / '.claude.json']

    def write_config(self, profile: Profile) -> None:
        settings = {'env': {'ANTHROPIC_BASE_URL': profile.fake_base_url, 'ANTHROPIC_API_KEY': safety.FAKE_KEY}}
        self.settings_path(profile).write_text(json.dumps(settings, indent=2))
        self.seed(profile)

    def seed(self, profile: Profile) -> None:
        """Merge onboarding, folder trust and the fake key's approval into every
        `.claude.json`. Merge, never seed-if-absent: `claude plugin install`
        creates the file first, and seeding only a missing file once left
        Claude trying api.anthropic.com (round 11, E4)."""
        for path in self.state_files(profile):
            try:
                data = json.loads(path.read_text()) if path.exists() else {}
            except ValueError:
                data = {}
            if not isinstance(data, dict):
                data = {}
            data['hasCompletedOnboarding'] = True
            projects = data.setdefault('projects', {})
            projects.setdefault(str(profile.project), {})['hasTrustDialogAccepted'] = True
            approvals = data.setdefault('customApiKeyResponses', {})
            approved = approvals.setdefault('approved', [])
            for key in (safety.FAKE_KEY, safety.FAKE_KEY[-20:]):
                if key not in approved:
                    approved.append(key)
            approvals.setdefault('rejected', [])
            path.write_text(json.dumps(data, indent=2))

    def check_config(self, profile: Profile, argv: list[str]) -> dict[str, bool]:
        # Rule 5 for Claude: re-merge first (a plugin install may have rewritten
        # the file), then verify; the URL and key are verified, never rewritten.
        self.seed(profile)
        checks: dict[str, bool] = {}
        try:
            settings = json.loads(self.settings_path(profile).read_text())
        except (OSError, ValueError):
            settings = {}
        env = settings.get('env', {}) if isinstance(settings, dict) else {}
        checks['settings-url'] = env.get('ANTHROPIC_BASE_URL') == profile.fake_base_url
        checks['settings-key'] = env.get('ANTHROPIC_API_KEY') == safety.FAKE_KEY
        checks['settings-no-other-provider'] = not any(
            k in env for k in ('CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_AUTH_TOKEN')
        )
        for path in self.state_files(profile):
            data = json.loads(path.read_text())
            label = path.relative_to(profile.root)
            checks[f'onboarding:{label}'] = data.get('hasCompletedOnboarding') is True
            trust = data.get('projects', {}).get(str(profile.project), {})
            checks[f'trust:{label}'] = trust.get('hasTrustDialogAccepted') is True
            checks[f'key-approved:{label}'] = safety.FAKE_KEY in data.get('customApiKeyResponses', {}).get('approved', [])
            checks[f'no-oauth:{label}'] = 'oauthAccount' not in data and 'primaryApiKey' not in data
        checks['settings-flag'] = '--settings' in argv and str(self.settings_path(profile)) in argv
        return checks

    def launch_argv(self, install: Install, profile: Profile) -> list[str]:
        return [
            *install.argv(),
            '--settings',
            str(self.settings_path(profile)),
            '--strict-mcp-config',
            '--mcp-config',
            '{"mcpServers":{}}',
            '--tools',
            '',
            '--debug-file',
            str(profile.logs / 'claude-debug.log'),
        ]

    # Probes name the settings file too, so every Claude command reads the fake URL.
    def version_argv(self, install: Install, profile: Profile) -> list[str]:
        return [*install.argv(), '--settings', str(self.settings_path(profile)), '--version']

    def help_argv(self, install: Install, profile: Profile) -> list[str]:
        return [*install.argv(), '--settings', str(self.settings_path(profile)), '--help']

    # The title request wraps the transcript in <session>; it is not a prompt.
    auxiliary_markers = ('<session>',)
    # Seeding makes these impossible; seeing one means the profile did not take (E4).
    refuse_screens = (
        'Do you trust the files in this folder',
        'Yes, I trust this folder',
        'Do you want to use this API key',
        'Choose the text style',
        'Select login method',
    )

    def _prompt_frame(self, screen: ScreenView) -> tuple[int, int] | None:
        frame = framed_rows(screen)
        if frame is None:
            return None
        return frame if screen.row(frame[0] + 1)[:1] in ('❯', '!', '#') else None

    def ready(self, screen: ScreenView) -> bool:
        frame = self._prompt_frame(screen)
        return frame is not None and screen.row(frame[0] + 1).startswith('❯')

    def prompt_rows(self, screen: ScreenView) -> list[str] | None:
        # `❯ ` then the draft; continuation rows are indented by two columns (2.1.302–2.1.306).
        frame = self._prompt_frame(screen)
        if frame is None:
            return None
        top, bottom = frame
        return [row[2:] for row in screen.lines[top + 1 : bottom]]

    def mode(self, screen: ScreenView) -> str:
        frame = self._prompt_frame(screen)
        if frame is None:
            return 'no-prompt'
        glyph = screen.row(frame[0] + 1)[:1]
        if glyph == '!':
            return 'shell'  # bash mode: a driver once ran control text here (E5)
        if glyph == '#':
            return 'memory'
        if '-- NORMAL --' in screen.row(frame[1] + 1):
            return 'vim-normal'
        return 'prose'

    def leave_mode(self, driver, mode: str) -> None:
        if mode in ('shell', 'memory'):
            # Empty the draft; Backspace on the empty prompt then leaves the mode.
            self.clear_draft(driver)
            driver.key('Backspace')
        elif mode == 'vim-normal':
            driver.write('i')
        else:
            driver.key('Escape')

    def canary_screen(self, screen: ScreenView, version: str) -> dict[str, bool]:
        frame = self._prompt_frame(screen)
        return {
            'header-version': f'Claude Code v{version}' in screen.text,
            'prompt-glyph-framed': self.ready(screen),
            'cursor-on-prompt': frame is not None and screen.cursor[1] == frame[0] + 1,
        }

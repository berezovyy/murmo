"""What the harness needs to know about one host.

A `HostProfile` covers a stock host: where its binary sits in an npm
install, how to write its fake-provider config and check it, its sandboxed
launch argv, when it is ready, how to read the draft off its screen, which
mode it is in, how to clear and submit, and its format canary. Murmo's
adapters (phases 21–24) plug in through `integrations.Integration`, not by
changing these classes.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..drivers.base import Driver, DriverRefused
from ..profile import Profile
from ..screen import ScreenView


@dataclass(frozen=True)
class Install:
    """One host version installed for one platform in the harness cache."""

    host: str
    version: str
    platform: str
    dir: Path
    # Argv prefix relative to `dir`; a leading `node` means "the Node on PATH".
    entry: tuple[str, ...]

    def argv(self, base: Path | None = None) -> list[str]:
        root = base or self.dir
        return [part if part == 'node' else str(root / part) for part in self.entry]

    def binary(self) -> Path:
        return self.dir / next(p for p in self.entry if p != 'node')

    def sha256(self) -> str:
        """The install's fingerprint: npm's lockfile (every package's version
        and tarball integrity) plus the entry binary. A launcher shim alone is
        identical across Codex and Pi releases, so it cannot tell them apart."""
        digest = hashlib.sha256()
        lock = self.dir / 'package-lock.json'
        digest.update(lock.read_bytes() if lock.exists() else b'')
        digest.update(self.binary().read_bytes())
        return digest.hexdigest()


@dataclass
class Canary:
    """Proof that a run hit the intended host format (knowledge § 9, E21)."""

    passed: bool
    checks: dict[str, bool] = field(default_factory=dict)
    detail: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {'passed': self.passed, 'checks': dict(self.checks), 'detail': dict(self.detail)}


class HostProfile:
    name = 'abstract'
    package = ''
    # The fake-server route this host's prompts must arrive on.
    route = ''
    # Seconds between typed keys (Claude drops keys typed faster than ~80 ms
    # while it renders, r12/r13 drivers; the others take 40 ms).
    key_delay = 0.04
    # Submit gestures as canonical key IDs.
    gestures: dict[str, str] = {'send': 'Enter', 'newline': 'Newline'}
    ready_timeout = 30.0

    # --- install ---------------------------------------------------------

    def entry(self, install_dir: Path, platform: str) -> tuple[str, ...]:
        """The argv prefix (relative to `install_dir`) that runs this host."""
        raise NotImplementedError

    def installed_version(self, install_dir: Path) -> str | None:
        manifest = install_dir / 'node_modules' / self.package / 'package.json'
        try:
            return json.loads(manifest.read_text())['version']
        except (OSError, ValueError, KeyError):
            return None

    # --- config and launch ------------------------------------------------

    def write_config(self, profile: Profile) -> None:
        raise NotImplementedError

    def check_config(self, profile: Profile, argv: list[str]) -> dict[str, bool]:
        raise NotImplementedError

    def launch_argv(self, install: Install, profile: Profile) -> list[str]:
        raise NotImplementedError

    def version_argv(self, install: Install, profile: Profile) -> list[str]:
        return [*install.argv(), '--version']

    def help_argv(self, install: Install, profile: Profile) -> list[str]:
        return [*install.argv(), '--help']

    def parse_version(self, output: str) -> str | None:
        import re

        match = re.search(r'\d+\.\d+\.\d+', output)
        return match.group(0) if match else None

    # --- the screen -------------------------------------------------------

    # Placeholder texts the empty prompt shows (measured per host and version).
    placeholders: tuple[str, ...] = ()
    # First-run screens that mean the profile seeding did not take: the session
    # fails instead of clicking through (rule 5).
    refuse_screens: tuple[str, ...] = ()

    def ready(self, screen: ScreenView) -> bool:
        raise NotImplementedError

    def on_startup_screen(self, driver: Driver, screen: ScreenView) -> None:
        for text in self.refuse_screens:
            if text in screen.text:
                raise DriverRefused(f'{self.name} shows a first-run screen the profile should have prevented: {text!r}')

    def prompt_rows(self, screen: ScreenView) -> list[str] | None:
        """The rows of the prompt's text, as drawn (no prompt glyph, no frame)."""
        raise NotImplementedError

    def read_draft(self, screen: ScreenView, placeholder: str | None = None) -> str | None:
        """The draft as the screen shows it; '' for an empty prompt, None if no
        prompt is visible. Rows are joined with newlines as drawn, so a line
        longer than the screen reads as two (fixtures keep lines short)."""
        rows = self.prompt_rows(screen)
        if rows is None:
            return None
        while rows and not rows[-1].strip():
            rows.pop()
        while rows and not rows[0].strip():
            rows.pop(0)
        text = '\n'.join(r.rstrip() for r in rows)
        if text in self.placeholders or (placeholder and text == placeholder):
            return ''
        return text

    def mode(self, screen: ScreenView) -> str:
        """`prose` when typed text goes into the draft. Anything else stops the
        driver: in shell mode, typed text would run as a command (E5)."""
        draft = self.read_draft(screen)
        if draft is None:
            return 'no-prompt'
        if draft.startswith('!'):
            return 'shell'
        return 'prose'

    def leave_mode(self, driver: Driver, mode: str) -> None:
        if mode == 'shell':
            self.clear_draft(driver)
        else:
            driver.key('Escape')

    def ensure_prose(self, driver: Driver, attempts: int = 2) -> None:
        """Check the host mode before typing (rule 6)."""
        for _ in range(attempts + 1):
            mode = self.mode(driver.screen())
            if mode == 'prose':
                return
            self.leave_mode(driver, mode)
            driver.settle(quiet=0.2, timeout=2)
        raise DriverRefused(f'{self.name} is in {self.mode(driver.screen())!r} mode; refusing to type')

    def clear_draft(self, driver: Driver, placeholder: str | None = None) -> bool:
        """End, then one Backspace per character (newlines included): the one
        clear every host handles the same way. Returns True once empty."""
        for _ in range(4):
            draft = self.read_draft(driver.screen(), placeholder)
            if not draft:
                return draft == ''
            driver.write_key('End')
            for _ in range(len(draft) + 2):
                driver.write_key('Backspace')
                time.sleep(0.003)
            driver.settle(quiet=0.15, timeout=2)
        return self.read_draft(driver.screen(), placeholder) == ''

    def paste(self, driver: Driver, text: str) -> None:
        driver.paste(text)

    def submit(self, driver: Driver, gesture: str = 'send') -> None:
        try:
            key = self.gestures[gesture]
        except KeyError:
            raise DriverRefused(f'{self.name} has no {gesture!r} gesture') from None
        driver.key(key)

    def busy(self, screen: ScreenView) -> bool:
        return False

    # --- fake-server requests ---------------------------------------------

    # Network attempts this host makes at every start that are measured, not
    # provider traffic, and blocked like any other: `target` -> why it is known.
    known_attempts: dict[str, str] = {}

    # Prefixes of the host's own side requests (title generation): their user
    # text or system prompt starts with one of these. They are not prompts.
    auxiliary_markers: tuple[str, ...] = ()

    def is_auxiliary(self, record: dict) -> bool:
        text = (record.get('userText') or '').lstrip()
        system = _system_text(record.get('body') or {}).lstrip()
        return any(text.startswith(m) or system.startswith(m) for m in self.auxiliary_markers)

    def prompt_requests(self, records: list[dict]) -> list[dict]:
        """Model requests that carry a prompt (route matches, side requests dropped)."""
        return [
            r for r in records
            if r.get('status') == 200 and r.get('route') in ('anthropic', 'responses', 'chat') and not self.is_auxiliary(r)
        ]

    # --- the canary ------------------------------------------------------

    def canary_screen(self, screen: ScreenView, version: str) -> dict[str, bool]:
        """Host-specific format checks on a ready screen."""
        return {}

    def canary(self, *, version: str, reported: str | None, ready_screen: ScreenView, requests: list[dict]) -> Canary:
        """Version, screen format and wire format all have to be what this
        profile was written for; a mismatch fails the run (E21)."""
        checks = {
            'version-matches': reported == version,
            'draft-readable': self.read_draft(ready_screen) is not None,
            **self.canary_screen(ready_screen, version),
        }
        model = [r for r in requests if r.get('route') in ('anthropic', 'responses', 'chat')]
        if model:
            checks['route'] = all(r.get('route') == self.route for r in model)
        return Canary(all(checks.values()), checks, {'reported': reported, 'expected': version})


def _system_text(body: dict) -> str:
    system = body.get('system') or body.get('instructions')
    if system is None:
        messages = body.get('messages') or body.get('input') or []
        first = next((m for m in messages if isinstance(m, dict) and m.get('role') in ('system', 'developer')), None)
        system = first.get('content') if first else ''
    if isinstance(system, list):
        return ' '.join(p.get('text', '') for p in system if isinstance(p, dict))
    return system if isinstance(system, str) else ''


def framed_rows(screen: ScreenView, *, rule: str = '─') -> tuple[int, int] | None:
    """The last two full-width rule rows (Pi and Claude frame their prompt so)."""
    rules = [y for y, line in enumerate(screen.lines) if len(line.strip()) >= 20 and set(line.strip()) == {rule}]
    if len(rules) < 2:
        return None
    return rules[-2], rules[-1]

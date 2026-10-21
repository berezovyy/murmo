"""The seam Murmo's adapters plug into (phases 21–24).

A run is stock (no Murmo) unless an integration says otherwise. An adapter
phase adds `harness/integrations/<name>.py` defining `INTEGRATION`, an
`Integration` subclass, and per-host expectation files under
`harness/expectations/`; the harness itself does not change.

What an integration can do:
- `prepare`: install Murmo into the run's profile (for example `murmo setup`
  run through `Run.host_command`, so the pre-launch check runs again after it).
- `argv`: change the launch command. Phase 23 wraps Codex in `murmo codex`
  here; the Codex pre-launch check still requires the rule 4 flags on the
  final command line.
- `logs`: files the watchdog follows (Murmo's state JSONL, helper logs).
- `state`: per-plugin state (enabled, disabled, faults) read apart from
  session health, because a "healthy" session once hid a disabled plugin
  (lessons 71, 76).
- `read_ui`: ghost, menu and status as the adapter renders them.
- `capabilities`: the adapter's measured `Capabilities` record, which phase
  11 turns into host profiles.
"""

from __future__ import annotations

import importlib.util
from dataclasses import dataclass, field
from pathlib import Path

from . import paths


@dataclass
class PluginState:
    id: str
    enabled: bool
    disabled_reason: str | None = None
    faults: int = 0


@dataclass
class IntegrationState:
    # What the session reports about itself (None: there is no Murmo session).
    healthy: bool | None = None
    plugins: list[PluginState] = field(default_factory=list)
    stats: dict[str, int] = field(default_factory=dict)
    notices: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            'healthy': self.healthy,
            'plugins': [p.__dict__ for p in self.plugins],
            'disabled': sorted(p.id for p in self.plugins if not p.enabled),
            'stats': dict(self.stats),
            'notices': list(self.notices),
        }


class Integration:
    name = 'stock'
    # Fixture features this integration provides (`requires` paths a case may name).
    features: frozenset[str] = frozenset()
    # True when it runs third-party code (peer plugins, ported ecosystem
    # code): safety rule 7 allows that only in a --network none container.
    third_party: bool = False

    def prepare(self, host, profile) -> None:
        """Install Murmo into the profile before launch. Stock: nothing."""

    def argv(self, host, install, profile, argv: list[str]) -> list[str]:
        return argv

    def logs(self, host, profile) -> list[Path]:
        return []

    def state(self, host, profile) -> IntegrationState:
        return IntegrationState()

    def read_ui(self, host, screen) -> dict | None:
        """{'ghost': ..., 'menu': [...], 'status': ...}, or None if this
        integration cannot read them (stock hosts have no Murmo UI)."""
        return None

    def capabilities(self, host, profile) -> dict | None:
        return None


STOCK = Integration()


def load(name: str, directory: Path = paths.INTEGRATIONS) -> Integration:
    """`stock`, or the integration in `harness/integrations/<name>.py`."""
    if name == 'stock':
        return STOCK
    path = directory / f'{name}.py'
    if not path.exists():
        known = sorted(p.stem for p in directory.glob('*.py')) if directory.exists() else []
        raise ValueError(f'no integration {name!r} (known: stock{", " if known else ""}{", ".join(known)})')
    spec = importlib.util.spec_from_file_location(f'murmo_harness_integration_{name}', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    integration = getattr(module, 'INTEGRATION', None)
    if not isinstance(integration, Integration):
        raise ValueError(f'{path} must define INTEGRATION, an Integration instance')
    return integration

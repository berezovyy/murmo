"""Shared test helpers: the stub host's profile, real-install lookup, and
a temporary stop marker so a test's deliberate stop never blocks real runs."""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from murmo_harness import paths  # noqa: E402
from murmo_harness.hosts import HOSTS  # noqa: E402
from murmo_harness.hosts.base import HostProfile, Install  # noqa: E402
from murmo_harness.install import InstallError, installed  # noqa: E402
from murmo_harness.profile import Profile  # noqa: E402
from murmo_harness.screen import ScreenView  # noqa: E402
from murmo_harness.session import Run  # noqa: E402

STUB = HERE / 'stubhost.py'


class StubHost(HostProfile):
    name = 'stub'
    route = 'chat'
    ready_timeout = 10.0
    key_delay = 0.005
    flags: list[str] = []

    def write_config(self, profile: Profile) -> None:
        (profile.root / 'stub.json').write_text('{"provider": "fake"}')

    def check_config(self, profile: Profile, argv: list[str]) -> dict[str, bool]:
        return {'stub-config': (profile.root / 'stub.json').exists()}

    def launch_argv(self, install: Install, profile: Profile) -> list[str]:
        profile.env['STUB_LOG'] = str(profile.logs / 'stub-debug.log')
        return [*install.argv(), *self.flags]

    def version_argv(self, install: Install, profile: Profile) -> list[str]:
        return [*install.argv(), '--version']

    def help_argv(self, install: Install, profile: Profile) -> list[str]:
        return [*install.argv(), '--help-text']

    def ready(self, screen: ScreenView) -> bool:
        return any(line.startswith('› ') or line == '›' for line in screen.lines)

    def prompt_rows(self, screen: ScreenView) -> list[str] | None:
        rows = [y for y, line in enumerate(screen.lines) if line.startswith('›')]
        if not rows:
            return None
        out = [screen.row(rows[0])[2:]]
        for y in range(rows[0] + 1, len(screen.lines)):
            line = screen.row(y)
            if not line.startswith('  ') or not line.strip():
                break
            out.append(line[2:])
        return out


def stub_install() -> Install:
    return Install('stub', '1.0.0', paths.current_platform(), HERE, (sys.executable, str(STUB)))


@contextmanager
def stub_host(*flags: str):
    host = StubHost()
    host.flags = list(flags)
    HOSTS['stub'] = host
    try:
        yield host
    finally:
        HOSTS.pop('stub', None)


@contextmanager
def scratch():
    path = Path(tempfile.mkdtemp(prefix='murmo-harness-test-'))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def new_run(folder: Path, **kw) -> Run:
    """A run whose stop marker lives in the test's scratch folder."""
    kw.setdefault('stop_marker', folder / 'STOPPED-PROVIDER.json')
    return Run(folder / 'evidence', **kw)


def real_install(host: str, version: str | None = None) -> Install:
    """A cached real host, or skip the test with how to install it."""
    from murmo_harness.install import load_matrix

    version = version or load_matrix().versions(host)[0]
    try:
        return installed(host, version, paths.current_platform())
    except InstallError as error:
        raise unittest.SkipTest(f'{error}') from None


def in_container() -> bool:
    from murmo_harness.sandbox import in_no_network_container

    return in_no_network_container()


def needs_sandbox() -> None:
    """Hosts only start sandboxed: macOS sandbox-exec, or inside the container."""
    if sys.platform == 'darwin' or in_container():
        return
    raise unittest.SkipTest('Linux tests run inside the harness container (`pnpm harness test --linux`)')


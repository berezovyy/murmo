"""Where the harness keeps things.

The host cache is shared by every checkout and worktree, like the Rust target
folder in AGENTS.md: `<main checkout>/experiments/.cache/hosts`, git-ignored.
Run outputs go to `harness/out/<suite>/<host>/<attempt>/` in this checkout.
Temporary run folders (HOME, profiles, sockets) live under the system temp
folder and are deleted after every run.
"""

from __future__ import annotations

import os
import platform
import subprocess
import tempfile
from pathlib import Path

HARNESS = Path(__file__).resolve().parent.parent
REPO = HARNESS.parent
OUT = HARNESS / 'out'
FIXTURES = REPO / 'fixtures'
EXPECTATIONS = HARNESS / 'expectations'
INTEGRATIONS = HARNESS / 'integrations'
SANDBOX_TEMPLATE = HARNESS / 'sandbox' / 'network.sb'
TMUX_CONF = HARNESS / 'tmux.conf'
TMUX_EXTENDED_CONF = HARNESS / 'tmux-extended.conf'
MATRIX = HARNESS / 'matrix.toml'
DOCKERFILE_DIR = HARNESS / 'docker'

# Prefix of every temporary run folder, tmux socket and container name. The
# cleanup check looks for leftovers by this prefix, and only ever removes
# things that carry its own run id.
RUN_PREFIX = 'murmo-harness-'


def main_checkout(cwd: Path = REPO) -> Path:
    """The main checkout (parent of git's common dir), shared by all worktrees."""
    try:
        common = subprocess.run(
            ['git', 'rev-parse', '--git-common-dir'],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return cwd
    path = Path(common)
    return (path if path.is_absolute() else (cwd / path)).resolve().parent


def cache_root() -> Path:
    """The shared harness cache; MURMO_HARNESS_CACHE overrides it (containers)."""
    override = os.environ.get('MURMO_HARNESS_CACHE')
    if override:
        return Path(override).resolve()
    return main_checkout() / 'experiments' / '.cache' / 'hosts'


def host_install_dir(host: str, version: str, plat: str) -> Path:
    return cache_root() / host / version / plat


def npm_cache_dir() -> Path:
    return cache_root() / '_npm-cache'


def python_venv_dir() -> Path:
    return cache_root() / '_python' / 'venv'


def stop_marker() -> Path:
    """The global STOPPED-PROVIDER marker. While it exists no host starts, in any worktree.
    Inside the Linux container the cache is read-only, so the container writes
    its marker into the out folder and the outer harness moves it here."""
    override = os.environ.get('MURMO_HARNESS_STOP_MARKER')
    if override:
        return Path(override)
    return cache_root() / 'STOPPED-PROVIDER.json'


def temp_root() -> Path:
    """Real path of the system temp folder (macOS /var is a symlink to /private/var)."""
    return Path(tempfile.gettempdir()).resolve()


def current_platform() -> str:
    """`darwin-arm64`, `linux-arm64`, `linux-x64`: the host package platform names we install."""
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(machine)
    if system not in ('darwin', 'linux') or arch is None:
        raise RuntimeError(f'unsupported platform {system}-{machine}: the harness runs on macOS and Linux only')
    return f'{system}-{arch}'

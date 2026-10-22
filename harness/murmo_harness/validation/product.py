"""The packed v1 candidate: locate it, pin its hash, run `murmo setup`.

The whole validation run uses one pin (docs/plan/29 task 1). Missing product
is a named skip, never a pass. Setup runs inside the session profile so HOME
is throwaway and the pre-launch check sees the result.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from .. import paths

INTEGRITY = 'integrity.json'
CLI = 'cli.mjs'
ENV_PACKED = 'MURMO_PACKED'
ENV_KEY = 'MURMO_TRUST_KEY'


@dataclass(frozen=True)
class PackedProduct:
    root: Path
    sha256: str
    version: str
    commit: str | None
    key_path: Path | None
    tarball: Path | None = None

    def as_dict(self) -> dict:
        return {
            'root': str(self.root),
            'sha256': self.sha256,
            'version': self.version,
            'commit': self.commit,
            'key': str(self.key_path) if self.key_path else None,
            'tarball': str(self.tarball) if self.tarball else None,
        }

    def cli(self) -> Path:
        return self.root / CLI

    def helper(self, plat: str) -> Path:
        return self.root / 'bin' / plat / 'murmo-plugin-host'

    def wrapper(self, plat: str) -> Path:
        return self.root / 'bin' / plat / 'murmo-codex'

    def has_helper(self, plat: str) -> bool:
        path = self.helper(plat)
        return path.is_file() and os.access(path, os.X_OK)

    def has_wrapper(self, plat: str) -> bool:
        path = self.wrapper(plat)
        return path.is_file() and os.access(path, os.X_OK)


def _integrity_pin(root: Path) -> tuple[str, str, str | None]:
    data = json.loads((root / INTEGRITY).read_text())
    digest = hashlib.sha256((root / INTEGRITY).read_bytes()).hexdigest()
    return digest, str(data.get('version') or '0.0.0'), data.get('commit')


def _key_beside(root: Path) -> Path | None:
    env = os.environ.get(ENV_KEY) or os.environ.get('MURMO_SIGNING_KEY')
    if env:
        path = Path(env)
        return path if path.is_file() else None
    for name in ('public.pem', 'trust.pem', 'key.pem'):
        candidate = root.parent / name
        if candidate.is_file():
            return candidate
        candidate = root / name
        if candidate.is_file():
            return candidate
    return None


def _from_dir(root: Path) -> PackedProduct | None:
    root = root.resolve()
    if not (root / INTEGRITY).is_file() or not (root / CLI).is_file():
        return None
    sha256, version, commit = _integrity_pin(root)
    tarball = None
    for path in sorted(root.parent.glob('murmo-*.tgz')):
        tarball = path
        break
    return PackedProduct(root, sha256, version, commit, _key_beside(root), tarball)


def locate_packed(override: str | Path | None = None) -> PackedProduct | None:
    """MURMO_PACKED, else dist/release/package, else None. Never builds."""
    raw = override or os.environ.get(ENV_PACKED)
    if raw:
        return _from_dir(Path(raw))
    dist = paths.REPO / 'dist' / 'release' / 'package'
    if dist.is_dir():
        return _from_dir(dist)
    return None


def node_bin() -> str:
    node = shutil.which('node')
    if node is None:
        raise RuntimeError('node is not on PATH; packed setup needs it')
    return node


def setup_argv(product: PackedProduct) -> list[str]:
    argv = [node_bin(), str(product.cli()), 'setup', '--json', '--package', str(product.root)]
    if product.key_path is not None:
        argv += ['--key', str(product.key_path)]
    return argv


def doctor_argv(product: PackedProduct) -> list[str]:
    argv = [node_bin(), str(product.cli()), 'doctor', '--json']
    if product.key_path is not None:
        argv += ['--key', str(product.key_path)]
    return argv


def plugin_argv(product: PackedProduct, args: list[str]) -> list[str]:
    return [node_bin(), str(product.cli()), 'plugin', *args]


def enable_autocorrect(profile) -> None:
    """Plugin set (b): user file, not a project file (a project cannot turn it on)."""
    config = Path(profile.env['XDG_CONFIG_HOME']) / 'murmo' / 'murmo.toml'
    config.parent.mkdir(parents=True, exist_ok=True)
    existing = config.read_text() if config.is_file() else ''
    if '[autocorrect]' not in existing:
        config.write_text(existing + '\n[autocorrect]\nenabled = true\n')
        return
    config.write_text(existing.replace('enabled = false', 'enabled = true'))


def murmo_data(profile) -> Path:
    return Path(profile.env['XDG_DATA_HOME']) / 'murmo'


def launcher_path(profile) -> Path:
    return Path(profile.env['HOME']) / '.local' / 'bin' / 'murmo'

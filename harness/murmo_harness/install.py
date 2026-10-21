"""Version matrix installer (`harness/matrix.toml`) and the shared host cache.

Hosts install with npm into `<cache>/<host>/<version>/<platform>/`, never
globally, with install scripts off: no third-party code runs at install time
(the Claude and OpenCode postinstall scripts only copy the platform binary,
which the host profile finds in the platform package instead). Linux
binaries install on any machine through npm's --os/--cpu/--libc flags and
are mounted read-only into the no-network container. The npm registry is the
only network this module touches, and `npm` runs with an empty user config
so no token from the real `~/.npmrc` is read.

pyte goes into a venv in the same cache, from pip or from a local copy of
the pinned release checked file by file against its RECORD.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
from dataclasses import dataclass
from pathlib import Path

from . import paths
from .hosts import HOSTS
from .hosts.base import Install

RECORD_FILE = 'murmo-harness-install.json'


@dataclass(frozen=True)
class HostEntry:
    name: str
    package: str
    versions: tuple[str, ...]
    latest: bool


@dataclass(frozen=True)
class Matrix:
    hosts: dict[str, HostEntry]
    python: dict[str, str]
    linux_platforms: tuple[str, ...]

    def versions(self, host: str, *, latest: str | None = None) -> list[str]:
        entry = self.hosts[host]
        out = list(entry.versions)
        if latest and latest not in out:
            out.append(latest)
        return out


def load_matrix(path: Path = paths.MATRIX) -> Matrix:
    data = tomllib.loads(path.read_text())
    hosts = {}
    for name, entry in data['hosts'].items():
        if name not in HOSTS:
            raise ValueError(f'matrix.toml names unknown host {name!r}')
        if entry['package'] != HOSTS[name].package:
            raise ValueError(f'matrix.toml package for {name} disagrees with its host profile')
        hosts[name] = HostEntry(name, entry['package'], tuple(entry['versions']), bool(entry.get('latest')))
    return Matrix(hosts, dict(data.get('python', {})), tuple(data.get('platforms', {}).get('linux', [])))


class InstallError(RuntimeError):
    pass


def _npm_env(scratch: Path) -> dict[str, str]:
    # npm refuses one file as both user and global config.
    empty_user = scratch / 'npmrc-user'
    empty_global = scratch / 'npmrc-global'
    empty_user.touch()
    empty_global.touch()
    return {
        'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
        'HOME': str(scratch),
        'npm_config_cache': str(paths.npm_cache_dir()),
        'npm_config_userconfig': str(empty_user),
        'npm_config_globalconfig': str(empty_global),
        'npm_config_update_notifier': 'false',
        'npm_config_fund': 'false',
        'npm_config_audit': 'false',
    }


def _npm(args: list[str], scratch: Path, timeout: float = 900) -> subprocess.CompletedProcess:
    npm = shutil.which('npm')
    if npm is None:
        raise InstallError('npm is not on PATH')
    return subprocess.run([npm, *args], env=_npm_env(scratch), capture_output=True, text=True, timeout=timeout)


def resolve_latest(package: str) -> str:
    """The registry's `latest` dist-tag (the only registry read besides installs)."""
    with tempfile.TemporaryDirectory(prefix=paths.RUN_PREFIX + 'npm-') as scratch:
        done = _npm(['view', package, 'dist-tags.latest'], Path(scratch), timeout=120)
    if done.returncode != 0 or not done.stdout.strip():
        raise InstallError(f'npm view {package} failed: {done.stderr.strip()[-500:]}')
    return done.stdout.strip()


def _platform_flags(plat: str) -> list[str]:
    system, arch = plat.split('-', 1)
    flags = [f'--os={system}', f'--cpu={arch}']
    if system == 'linux':
        flags.append('--libc=glibc')  # the container image is Debian bookworm
    return flags


def installed(host: str, version: str, plat: str, base: Path | None = None) -> Install:
    """The cached install, checked: its record exists and its binary hash matches."""
    directory = (base / host / version / plat) if base else paths.host_install_dir(host, version, plat)
    record_path = directory / RECORD_FILE
    try:
        record = json.loads(record_path.read_text())
    except (OSError, ValueError):
        raise InstallError(f'{host} {version} ({plat}) is not installed; run `pnpm harness install {host} --version {version}`') from None
    install = Install(host, version, plat, directory, tuple(record['entry']))
    if not install.binary().exists():
        raise InstallError(f'{install.binary()} is missing; reinstall {host} {version}')
    if install.sha256() != record.get('sha256'):
        raise InstallError(f'{host} {version} ({plat}) differs from its install record; reinstall it')
    return install


def install(host: str, version: str, plat: str, *, force: bool = False) -> tuple[Install, dict]:
    profile = HOSTS[host]
    directory = paths.host_install_dir(host, version, plat)
    if not force:
        try:
            existing = installed(host, version, plat)
            record = json.loads((directory / RECORD_FILE).read_text())
            if existing.sha256() == record['sha256']:
                return existing, {**record, 'reused': True}
        except InstallError:
            pass
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True)
    (directory / 'package.json').write_text(json.dumps({'private': True, 'dependencies': {profile.package: version}}, indent=2) + '\n')
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix=paths.RUN_PREFIX + 'npm-') as scratch:
        done = _npm(
            ['install', '--prefix', str(directory), '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev',
             '--save-exact', *_platform_flags(plat)],
            Path(scratch),
        )
        npm_version = _npm(['--version'], Path(scratch)).stdout.strip()
    if done.returncode != 0:
        shutil.rmtree(directory, ignore_errors=True)
        raise InstallError(f'npm install {profile.package}@{version} ({plat}) failed: {done.stderr.strip()[-1500:]}')
    actual = profile.installed_version(directory)
    if actual != version:
        shutil.rmtree(directory, ignore_errors=True)
        raise InstallError(f'npm installed {profile.package}@{actual}, not {version}')
    entry = profile.entry(directory, plat)
    install_record = Install(host, version, plat, directory, entry)
    if not install_record.binary().exists():
        shutil.rmtree(directory, ignore_errors=True)
        raise InstallError(f'{profile.package}@{version} has no binary for {plat} at {install_record.binary()}')
    record = {
        'host': host,
        'package': profile.package,
        'version': version,
        'platform': plat,
        'entry': list(entry),
        'sha256': install_record.sha256(),
        'installedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'seconds': round(time.monotonic() - started, 1),
        'npm': npm_version,
    }
    (directory / RECORD_FILE).write_text(json.dumps(record, indent=2) + '\n')
    return install_record, record


# --- pyte --------------------------------------------------------------------


def _record_ok(site: Path, dist_info: Path) -> list[str]:
    """Files whose content differs from the dist-info RECORD (empty when intact)."""
    bad = []
    for line in (dist_info / 'RECORD').read_text().splitlines():
        name, digest, _size = (line.rsplit(',', 2) + ['', ''])[:3]
        if not digest or '__pycache__' in name:
            continue
        algo, _, expected = digest.partition('=')
        data = (site / name).read_bytes() if (site / name).exists() else None
        if data is None:
            bad.append(name)
            continue
        actual = base64.urlsafe_b64encode(hashlib.new(algo, data).digest()).rstrip(b'=').decode()
        if actual != expected:
            bad.append(name)
    return bad


def install_python(matrix: Matrix, *, from_site: Path | None = None) -> dict:
    """Create the venv and put the pinned pyte and wcwidth in it.

    `from_site` copies an existing install of exactly those versions (checked
    against their RECORD hashes) for machines where pip may not reach PyPI;
    otherwise pip installs them from PyPI.
    """
    venv = paths.python_venv_dir()
    pins = {'pyte': matrix.python['pyte'], 'wcwidth': matrix.python['wcwidth']}
    if not (venv / 'bin' / 'python3').exists():
        subprocess.run([sys.executable, '-m', 'venv', '--without-pip' if from_site else '--upgrade-deps', str(venv)], check=True, timeout=300)
    from .deps import site_packages

    site = site_packages(venv)
    if site is None:
        raise InstallError(f'no site-packages in {venv}')
    if from_site:
        for name, version in pins.items():
            dist = from_site / f'{name}-{version}.dist-info'
            if not dist.is_dir():
                raise InstallError(f'{from_site} has no {name} {version}')
            bad = _record_ok(from_site, dist)
            if bad:
                raise InstallError(f'{name} {version} in {from_site} differs from its RECORD: {bad[:5]}')
            shutil.copytree(from_site / name, site / name, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__'))
            shutil.copytree(dist, site / dist.name, dirs_exist_ok=True)
    else:
        pip = venv / 'bin' / 'pip'
        done = subprocess.run([str(pip), 'install', '--no-cache-dir', *(f'{n}=={v}' for n, v in pins.items())],
                              capture_output=True, text=True, timeout=600)
        if done.returncode != 0:
            raise InstallError(f'pip install failed: {done.stderr[-1000:]}')
    check = subprocess.run([str(venv / 'bin' / 'python3'), '-I', '-c', 'import pyte, wcwidth; print(pyte.__file__)'],
                           capture_output=True, text=True, timeout=60)
    if check.returncode != 0:
        raise InstallError(f'pyte does not import from the venv: {check.stderr[-500:]}')
    return {'venv': str(venv), 'site': str(site), 'pins': pins, 'source': str(from_site) if from_site else 'pypi'}

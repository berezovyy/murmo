"""Linux runs: the harness itself inside `docker run --network none`.

The outer harness (on macOS through Docker Desktop's Linux VM, or on a Linux
machine) builds the image in a separate step, then starts one container per
run with:

- `--network none` (rule 2), `--init`, the caller's uid, CPU knobs if asked;
- the repository read-only at /murmo (harness code and fixtures), the host
  cache read-only at /opt/murmo-hosts, pyte read-only at /opt/murmo-pylib, and
  only `harness/out` writable; never the real HOME (rule 8);
- a name and labels carrying the run id, so cleanup removes exactly this
  container and never touches anyone else's (rule 10).

Inside, the same harness code runs with the `linux-container` sandbox. A stop
on a provider hostname writes its marker into the out folder (the cache is
read-only there); the outer harness moves it to the global marker.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from . import deps, paths

LABEL = 'murmo-harness'
IMAGE_REPO = 'murmo-harness'
CONTAINER_OUT = '/murmo/harness/out'
CONTAINER_STOP_MARKER = f'{CONTAINER_OUT}/.container-STOPPED-PROVIDER.json'


def docker() -> str:
    found = shutil.which('docker')
    if found is None:
        raise RuntimeError('docker is not installed; Linux runs need it (there is no unshare fallback)')
    return found


def image_tag(target: str) -> str:
    digest = hashlib.sha256((paths.DOCKERFILE_DIR / 'Dockerfile').read_bytes()).hexdigest()[:12]
    return f'{IMAGE_REPO}:{target}-{digest}'


def build_image(target: str = 'base') -> str:
    """The separate, networked build step. It never starts a host."""
    tag = image_tag(target)
    present = subprocess.run([docker(), 'image', 'inspect', tag], capture_output=True, timeout=60)
    if present.returncode == 0:
        return tag
    done = subprocess.run(
        [docker(), 'build', '--target', target, '--label', f'{LABEL}=1', '-t', tag, str(paths.DOCKERFILE_DIR)],
        capture_output=True,
        text=True,
        timeout=1800,
    )
    if done.returncode != 0:
        raise RuntimeError(f'docker build failed: {done.stderr[-2000:]}')
    return tag


@dataclass
class Knobs:
    """Load knobs (Linux only: macOS has no CPU quota)."""

    cpus: float | None = None
    cpuset: str | None = None

    def args(self) -> list[str]:
        out = []
        if self.cpus is not None:
            out += ['--cpus', str(self.cpus)]
        if self.cpuset:
            out += ['--cpuset-cpus', self.cpuset]
        return out

    def as_dict(self) -> dict:
        return {'cpus': self.cpus, 'cpuset': self.cpuset}


@dataclass
class ContainerResult:
    name: str
    code: int
    seconds: float
    stopped_provider: dict | None
    leftover_containers: list[str]


def run(harness_args: list[str], *, run_id: str, target: str = 'base', knobs: Knobs | None = None,
        timeout: float = 3600) -> ContainerResult:
    """Run `harness.py <harness_args>` inside a fresh no-network container."""
    tag = build_image(target)
    name = f'{run_id}-linux'
    venv_site = deps.site_packages(paths.python_venv_dir())
    if venv_site is None or not (venv_site / 'pyte').is_dir():
        raise RuntimeError('pyte is not installed in the harness cache; run `pnpm harness install python` first')
    paths.OUT.mkdir(parents=True, exist_ok=True)
    stop_file = paths.OUT / '.container-STOPPED-PROVIDER.json'
    stop_file.unlink(missing_ok=True)
    argv = [
        docker(), 'run', '--rm', '--init', '--network', 'none',
        '--name', name, '--label', f'{LABEL}=1', '--label', f'{LABEL}.run={run_id}',
        '--user', f'{os.getuid()}:{os.getgid()}',
        '-e', 'HOME=/tmp', '-e', 'MURMO_HARNESS_CACHE=/opt/murmo-hosts',
        '-e', 'MURMO_HARNESS_PYLIB=/opt/murmo-pylib', '-e', f'MURMO_HARNESS_STOP_MARKER={CONTAINER_STOP_MARKER}',
        '-e', f'MURMO_HARNESS_PARENT_RUN={run_id}',
        '-v', f'{paths.REPO}:/murmo:ro',
        '-v', f'{paths.cache_root()}:/opt/murmo-hosts:ro',
        '-v', f'{venv_site}:/opt/murmo-pylib:ro',
        '-v', f'{paths.OUT}:{CONTAINER_OUT}',
        '-w', '/murmo',
        *(knobs.args() if knobs else []),
        tag, 'python3', '-I', '/murmo/harness/harness.py', *harness_args,
    ]
    started = time.monotonic()
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL)
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        code = -1
    except KeyboardInterrupt:
        code = -2
    finally:
        # Rule 11: this run's container goes, even after a failure; no other.
        subprocess.run([docker(), 'rm', '-f', name], capture_output=True, timeout=120)
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)
    stopped = None
    if stop_file.exists():
        stopped = json.loads(stop_file.read_text())
        marker = paths.stop_marker()
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps({**stopped, 'container': name}, indent=2) + '\n')
        stop_file.unlink()
    return ContainerResult(name, code, time.monotonic() - started, stopped, leftovers(run_id))


def leftovers(run_id: str) -> list[str]:
    done = subprocess.run(
        [docker(), 'ps', '-a', '--filter', f'label={LABEL}.run={run_id}', '--format', '{{.Names}}'],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return [n for n in done.stdout.split() if n]


def inside() -> bool:
    return bool(os.environ.get('MURMO_HARNESS_PARENT_RUN')) and sys.platform.startswith('linux')


def all_containers() -> list[str]:
    """Every container carrying the harness label (only ever ours)."""
    done = subprocess.run(
        [docker(), 'ps', '-a', '--filter', f'label={LABEL}=1', '--format', '{{.Names}}'],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return [n for n in done.stdout.split() if n]

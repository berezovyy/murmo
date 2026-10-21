"""The network sandbox (safety rules 2 and 3).

Two backends, one interface:

- macOS: every host process runs under `sandbox-exec` with the profile from
  `harness/sandbox/network.sb`, rendered per run: no network except loopback
  and local Unix sockets, no DNS, no access to the real agent folders.
- Linux: the whole harness runs inside `docker run --network none`
  (`container.py` starts it); inside, host commands run as they are. There is
  no `unshare` fallback.

`self_test()` runs inside the same sandbox before any host starts: a request
to the fake server must succeed, and a connection to 1.1.1.1:443 and a lookup
of a provider hostname must fail at once. A wrong result raises
`SandboxBroken`, and the caller starts no host.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import paths

SANDBOX_EXEC = '/usr/bin/sandbox-exec'

# The probe runs inside the sandbox with `python3 -I -c`. A blocked connect
# fails at once with one of these errnos; a timeout means a route exists.
_BLOCKED_ERRNOS = {1, 13, 51, 65, 101, 113}  # EPERM, EACCES, ENETUNREACH (mac/linux), EHOSTUNREACH (mac/linux)
_PROBE = r"""
import json, socket, sys, time, urllib.request
port, token = int(sys.argv[1]), sys.argv[2]
result = {}
try:
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/__harness/self-test', timeout=3) as r:
        result['loopback'] = r.read().decode() == token
except OSError as e:
    result['loopback'] = False
    result['loopbackError'] = repr(e)
s = socket.socket(); s.settimeout(2); t = time.monotonic()
try:
    s.connect(('1.1.1.1', 443)); result['external'] = {'connected': True}
except socket.timeout:
    result['external'] = {'connected': False, 'errno': None, 'timeout': True}
except OSError as e:
    result['external'] = {'connected': False, 'errno': e.errno, 'seconds': time.monotonic() - t}
finally:
    s.close()
try:
    socket.getaddrinfo('api.openai.com', 443); result['dns'] = {'resolved': True}
except OSError as e:
    result['dns'] = {'resolved': False, 'error': type(e).__name__}
print(json.dumps(result))
"""


class SandboxBroken(RuntimeError):
    """The self-test failed: the sandbox lets the network through, or blocks loopback."""


@dataclass
class SelfTest:
    passed: bool
    loopback: bool
    external_blocked: bool
    dns_blocked: bool
    raw: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            'passed': self.passed,
            'loopback': self.loopback,
            'externalBlocked': self.external_blocked,
            'dnsBlocked': self.dns_blocked,
            'raw': self.raw,
        }


def _judge(raw: dict) -> SelfTest:
    loopback = raw.get('loopback') is True
    external = raw.get('external', {})
    external_blocked = (
        external.get('connected') is False and not external.get('timeout') and external.get('errno') in _BLOCKED_ERRNOS
    )
    dns_blocked = raw.get('dns', {}).get('resolved') is False
    return SelfTest(loopback and external_blocked and dns_blocked, loopback, external_blocked, dns_blocked, raw)


class Sandbox:
    """Interface: wrap host argv, self-test, report denied attempts."""

    kind = 'abstract'
    # Pids of self-test probes: their denials are expected, not host attempts.
    probe_pids: set[int]

    def wrap(self, argv: list[str]) -> list[str]:
        raise NotImplementedError

    def self_test(self, port: int, token: str) -> SelfTest:
        argv = self.wrap([self.python(), '-I', '-c', _PROBE, str(port), token])
        env = {'PATH': '/usr/bin:/bin', 'HOME': str(paths.temp_root()), 'LANG': 'C.UTF-8'}
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        if not hasattr(self, 'probe_pids'):
            self.probe_pids = set()
        self.probe_pids.add(proc.pid)
        try:
            stdout, stderr = proc.communicate(timeout=20)
        except subprocess.TimeoutExpired as e:
            proc.kill()
            proc.communicate()
            raise SandboxBroken(f'self-test probe hung: {e}') from e
        try:
            raw = json.loads(stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError):
            raw = {'exit': proc.returncode, 'stderr': stderr[-2000:]}
        result = _judge(raw)
        if not result.passed:
            raise SandboxBroken(f'network self-test failed, no host will start: {json.dumps(result.as_dict())}')
        return result

    def python(self) -> str:
        return sys.executable

    def denied_records(self) -> dict:
        raise NotImplementedError

    def describe(self) -> dict:
        raise NotImplementedError


class MacSandbox(Sandbox):
    kind = 'macos-sandbox-exec'

    def __init__(self, run_id: str, run_root: Path, *, real_home: Path | None = None, profile_text: str | None = None):
        if not Path(SANDBOX_EXEC).exists():
            raise SandboxBroken('sandbox-exec is missing; macOS runs cannot be isolated (move them to a VM)')
        self.tag = run_id
        self.real_home = real_home or Path.home()
        self.profile_path = run_root / 'network.sb'
        # `profile_text` exists for the fails-closed test (a broken profile).
        self.expected = profile_text if profile_text is not None else render_profile(run_id, self.real_home)
        self.profile_path.write_text(self.expected)
        self.started = time.time()

    def wrap(self, argv: list[str]) -> list[str]:
        # Rule 5: the profile on disk is the one we rendered, checked at every launch.
        if self.profile_path.read_text() != self.expected:
            raise SandboxBroken(f'{self.profile_path} changed after it was rendered')
        return [SANDBOX_EXEC, '-f', str(self.profile_path), *argv]

    def denied_records(self) -> dict:
        """Denials tagged with this run's id, from the system log. Only the
        kernel's sandbox lines that carry our tag are read; macOS redacts
        remote addresses, so these are counts, not hostnames."""
        probes = getattr(self, 'probe_pids', set())
        # Each self-test probe leaves two denials (its connect and its lookup).
        # They prove the log is being read; the log ingests with a delay, so
        # read again until they are there (a zero count would mean nothing).
        result: dict = {'available': False}
        for _ in range(5):
            time.sleep(1.0)
            result = self._read_log(probes)
            if result.get('error') or result['counts']['selfTest'] >= 2 * len(probes):
                break
        result['available'] = not result.get('error') and result['counts']['selfTest'] >= 2 * max(1, len(probes))
        return result

    def _read_log(self, probes: set[int]) -> dict:
        start = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(self.started - 2))
        predicate = f'sender == "Sandbox" AND eventMessage CONTAINS "{self.tag}"'
        try:
            done = subprocess.run(
                ['/usr/bin/log', 'show', '--style', 'ndjson', '--start', start, '--predicate', predicate],
                capture_output=True,
                text=True,
                timeout=120,
            )
        except (OSError, subprocess.SubprocessError) as e:
            return {'error': str(e), 'counts': {'selfTest': 0}, 'records': []}
        if done.returncode != 0:
            return {'error': done.stderr[-500:], 'counts': {'selfTest': 0}, 'records': []}
        counts = {'network': 0, 'dns': 0, 'file': 0, 'other': 0, 'selfTest': 0}
        lines = []
        for line in done.stdout.splitlines():
            try:
                message = json.loads(line).get('eventMessage', '')
            except json.JSONDecodeError:
                continue
            if self.tag not in message or 'deny' not in message:
                continue
            pid = re.search(r'\((\d+)\) deny', message)
            if pid and int(pid.group(1)) in probes:
                counts['selfTest'] += 1  # the probe's own blocked connect and lookup
            elif 'mDNSResponder' in message:
                counts['dns'] += 1
            elif 'network' in message:
                counts['network'] += 1
            elif 'file-' in message:
                counts['file'] += 1
            else:
                counts['other'] += 1
            lines.append(message)
        return {'counts': counts, 'records': lines}

    def describe(self) -> dict:
        return {'kind': self.kind, 'profile': str(self.profile_path), 'tag': self.tag}


class ContainerSandbox(Sandbox):
    """Inside a `--network none` container started by container.py."""

    kind = 'linux-container'

    def __init__(self) -> None:
        if not in_no_network_container():
            raise SandboxBroken('not inside a --network none container: Linux runs must go through the container wrapper')

    def wrap(self, argv: list[str]) -> list[str]:
        return list(argv)

    def python(self) -> str:
        return sys.executable

    def denied_records(self) -> dict:
        # A namespace with only `lo` has no route; nothing records the attempts.
        return {'available': False, 'reason': 'no-network namespace: connects fail with ENETUNREACH, unrecorded'}

    def describe(self) -> dict:
        return {'kind': self.kind, 'interfaces': _interfaces()}


def _interfaces() -> list[str]:
    try:
        return sorted(os.listdir('/sys/class/net'))
    except OSError:
        return []


def in_no_network_container() -> bool:
    """True inside a Docker container whose only interface is loopback."""
    return Path('/.dockerenv').exists() and _interfaces() == ['lo']


def render_profile(run_id: str, real_home: Path) -> str:
    text = paths.SANDBOX_TEMPLATE.read_text()
    return text.replace('@RUN_TAG@', run_id).replace('@REAL_HOME@', str(real_home))


def for_platform(run_id: str, run_root: Path) -> Sandbox:
    """The sandbox for where we are: macOS sandbox-exec, or the container we run in."""
    if sys.platform == 'darwin':
        return MacSandbox(run_id, run_root)
    if sys.platform.startswith('linux'):
        return ContainerSandbox()
    raise SandboxBroken(f'unsupported platform {sys.platform}')

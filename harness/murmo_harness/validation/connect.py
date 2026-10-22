"""Outbound connect audit (docs/plan/29 task 11a, E18).

Allowed: the fake model on 127.0.0.1:<port>, Murmo's own Unix sockets, and
the loopback trap (which is how we *name* a blocked attempt). Everything else
from murmo, murmo-plugin-host, murmo-codex or the CLI is a finding: a
telemetry call, update check or remote fetch on the normal path.

Linux: `strace -f -e trace=connect` when present. macOS: trap records plus
the sandbox denial log as a cross-check. Missing strace is a named skip for
the strace sub-check only; the trap still runs.
"""

from __future__ import annotations

import os
import shutil
from urllib.parse import urlparse

MURMO_BINS = ('murmo', 'murmo-plugin-host', 'murmo-codex', 'cli.mjs', 'cli.ts')


def classify_target(target: str, *, fake_port: int | None, trap_port: int | None) -> str:
    """'allowed' | 'unexpected'. Loopback fake/trap and unix sockets are allowed."""
    raw = (target or '').strip()
    if not raw:
        return 'unexpected'
    if raw.startswith('unix:') or raw.startswith('/') or raw.endswith('.sock'):
        return 'allowed'
    parsed = urlparse(raw if '://' in raw else f'http://{raw}')
    host = (parsed.hostname or '').lower()
    port = parsed.port
    if host in ('127.0.0.1', 'localhost', '::1'):
        if fake_port and port == fake_port:
            return 'allowed'
        if trap_port and port == trap_port:
            return 'allowed'
        if port is None:
            return 'allowed'
        # Other loopback ports: still on this computer, but not the fake model
        # or the trap. Doctor/plugin list/normal typing must not open them.
        return 'unexpected'
    return 'unexpected'


def is_murmo_process(command: str) -> bool:
    return any(name in command for name in MURMO_BINS)


def audit_connects(records: list[dict], *, fake_port: int | None, trap_port: int | None,
                   commands: list[str] | None = None) -> dict:
    """Classify trap/strace records. `commands` are process command lines, if known."""
    allowed, unexpected, murmo_unexpected = [], [], []
    for record in records:
        target = record.get('target') or record.get('addr') or ''
        kind = classify_target(str(target), fake_port=fake_port, trap_port=trap_port)
        row = {'target': target, 'method': record.get('method'), 'source': record.get('source', 'trap')}
        if kind == 'allowed':
            allowed.append(row)
            continue
        unexpected.append(row)
        command = record.get('command') or ''
        if command and is_murmo_process(command):
            murmo_unexpected.append(row)
        elif not command and commands and any(is_murmo_process(c) for c in commands):
            murmo_unexpected.append(row)
        elif not command:
            # No process attribution: count as Murmo-side until proven otherwise.
            # Hosts have their own known_attempts list; this audit is Murmo's.
            if record.get('murmo') is True or record.get('source') in ('murmo', 'helper', 'cli', 'wrapper'):
                murmo_unexpected.append(row)
    return {
        'allowed': allowed,
        'unexpected': unexpected,
        'murmoUnexpected': murmo_unexpected,
        'passed': not murmo_unexpected,
    }


def strace_available() -> bool:
    return shutil.which('strace') is not None and os.name == 'posix'


def strace_prefix() -> list[str]:
    """Wrap a launch: strace -f -e trace=connect -o <file> is filled by the runner."""
    return ['strace', '-f', '-e', 'trace=connect', '-s', '128']

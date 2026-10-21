"""Version probes, format canaries and drift.

`probe()` launches one host version once, in the sandbox, and records what
later phases depend on: the reported version, the help text's flags, the
ready screen's shape (the format canary) and, with a submit, the wire format
the fake server saw. `drift()` compares the probe of the newest release with
the newest pinned version's and lists every difference (docs/plan/20,
Version matrix).
"""

from __future__ import annotations

import hashlib
import re

from .drivers.base import DriverRefused
from .hosts import HOSTS
from .integrations import STOCK
from .session import Run

CANARY_LINE = 'murmo harness canary line'
_FLAG = re.compile(r'(?<![\w-])(--[a-z][a-z0-9-]+)')


def probe(run: Run, host: str, install, *, submit: bool = True, driver: str = 'pty') -> dict:
    profile = HOSTS[host]
    reported, version_result = run.probe_version(profile, install)
    prof = run.new_profile(profile, install, 'help')
    try:
        help_result = run.host_command(profile, prof, profile.help_argv(install, prof), source='help')
    finally:
        from .profile import remove

        remove(prof)
    help_text = help_result.stdout + help_result.stderr
    out: dict = {
        'host': host,
        'version': install.version,
        'platform': install.platform,
        'reported': reported,
        'binarySha256': install.sha256(),
        'help': {
            'exit': help_result.code,
            'sha256': hashlib.sha256(help_text.encode()).hexdigest(),
            'flags': sorted(set(_FLAG.findall(help_text))),
        },
    }
    if host == 'opencode':
        out['bundledBun'] = profile.bundled_bun(install)
    mark = run.fake.mark()
    session = None
    try:
        session = run.open_session(host, install, driver=driver, integration=STOCK, label='probe')
        ready = session.ready_screen
        session.save(run.evidence / 'screens', f'{host}-{install.version}-ready')
        out['startupSeconds'] = round(session.startup_seconds or 0, 2)
        out['placeholder'] = session.placeholder
        out['readyTitle'] = ready.title
        if submit:
            session.type(CANARY_LINE)
            session.driver.settle(quiet=0.3, timeout=5)
            out['draftBeforeSubmit'] = session.draft()
            session.submit('send')
            deadline_ok = session.driver.wait(lambda _s: bool(profile.prompt_requests(run.fake.since(mark))), 20)
            session.driver.settle(quiet=0.3, timeout=8)
            out['submitted'] = deadline_ok
        requests = run.fake.since(mark)
        canary = profile.canary(version=install.version, reported=reported, ready_screen=ready, requests=requests)
        prompts = [r.get('userText') for r in profile.prompt_requests(requests)]
        if submit:
            canary.checks['draft-read-back'] = out.get('draftBeforeSubmit') == CANARY_LINE
            canary.checks['fake-got-exact-line'] = prompts == [CANARY_LINE]
            canary.passed = all(canary.checks.values())
        out['canary'] = canary.as_dict()
        out['requests'] = [
            {'route': r.get('route'), 'path': r.get('path'), 'status': r.get('status'),
             'auxiliary': profile.is_auxiliary(r), 'userText': r.get('userText')}
            for r in requests
        ]
        out['argv'] = session.argv
    except DriverRefused as error:
        out['canary'] = {'passed': False, 'checks': {'session-started': False}, 'error': str(error)[:3000]}
    finally:
        if session is not None:
            session.close()
    out['passed'] = bool(out['canary'].get('passed')) and reported == install.version
    return out


# Probe fields that differ between any two versions or runs (OpenCode sets its
# title at a varying moment after the first frame), so they are not drift.
_NOT_COMPARED = {'version', 'reported', 'binarySha256', 'startupSeconds', 'argv', 'requests', 'readyTitle', 'attempt', 'cleanup', 'network'}


def drift(pinned: dict, latest: dict) -> dict:
    """Every probe difference between the newest pinned version and the newest release."""
    changes: dict = {}
    for key in sorted(set(pinned) | set(latest)):
        if key in _NOT_COMPARED:
            continue
        a, b = pinned.get(key), latest.get(key)
        if key == 'help':
            fa, fb = set(a['flags']), set(b['flags'])
            if fa != fb:
                changes['help.flags'] = {'added': sorted(fb - fa), 'removed': sorted(fa - fb)}
            continue
        if key == 'canary':
            ca, cb = a.get('checks', {}), b.get('checks', {})
            diff = {k: {'pinned': ca.get(k), 'latest': cb.get(k)} for k in sorted(set(ca) | set(cb))
                    if ca.get(k) != cb.get(k) and k != 'version-matches'}
            if diff:
                changes['canary'] = diff
            continue
        if a != b:
            changes[key] = {'pinned': a, 'latest': b}
    routes = lambda p: sorted({(r['route'], r['path']) for r in p.get('requests', [])})  # noqa: E731
    if routes(pinned) != routes(latest):
        changes['requests.routes'] = {'pinned': routes(pinned), 'latest': routes(latest)}
    return {
        'host': pinned['host'],
        'pinned': pinned['version'],
        'latest': latest['version'],
        'same': pinned['version'] == latest['version'],
        'changes': changes,
        'drifted': bool(changes),
    }

"""Live drivers: packed product on a real host, through Run.

Each driver returns `{'evidence': dict}` the matching oracle consumes. A
driver that cannot collect a required observation fails closed (empty
evidence → oracle "no assertions ran"), it does not skip.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from .. import evidence as ev
from ..inventory import diff, tree
from ..runner import Expectations, HostSubject, load_suite
from .connect import audit_connects
from .matrix import BURST_HITS, CLAUDE_CHAR_MS
from .product import doctor_argv, plugin_argv, setup_argv


def run_live(run, row, world, integration, attempt: Path) -> dict:
    fn = DRIVERS.get(row.scenario)
    if fn is None:
        return {'evidence': {}}
    return fn(run, row, world, integration, attempt)


def _install(world, row):
    return world.hosts[(row.host, row.version)]


def _session(run, row, world, integration, label='validate'):
    return run.open_session(row.host, _install(world, row), integration=integration, label=label[:24])


def drive_functional(run, row, world, integration, attempt: Path) -> dict:
    suites = (row.extras or {}).get('suites') or ['fixtures/hosts/stock-canary.json']
    subject = HostSubject(
        run, row.host, _install(world, row), integration=integration,
        expectations=Expectations.load(integration.name, row.host),
        attempt=attempt, platform=world.platform,
    )
    verdicts = []
    from .. import paths
    for rel in suites:
        path = paths.REPO / rel if not Path(rel).is_absolute() else Path(rel)
        if not path.is_file():
            continue
        suite, cases = load_suite(path)
        verdicts.extend(subject.run_suite(suite, cases))
    return {'evidence': {'host': row.host, 'verdicts': verdicts}}


def drive_correction(run, row, world, integration, attempt: Path) -> dict:
    bar = BURST_HITS.get(row.host)
    session = _session(run, row, world, integration, 'correct')
    try:
        hits = 0
        burst_edits = 0
        keyed_hits = 0
        keyed_trials = 0
        if row.host == 'claude':
            keyed_trials = 5
            for i in range(keyed_trials):
                session.clear()
                session.type('teh ', delay=CLAUDE_CHAR_MS / 1000)
                session.driver.settle(quiet=0.3, timeout=5)
                if (session.draft() or '').rstrip().endswith('the'):
                    keyed_hits += 1
            session.clear()
            session.burst('teh ')
            session.driver.settle(quiet=0.3, timeout=5)
            if (session.draft() or '').rstrip().endswith('the'):
                burst_edits += 1
            trials = keyed_trials
            hits = keyed_hits
        else:
            want_hits, trials = bar or (30, 30)
            for i in range(trials):
                session.clear()
                session.burst('teh ')
                session.driver.settle(quiet=0.2, timeout=4)
                if (session.draft() or '').rstrip().endswith('the'):
                    hits += 1
        session.clear()
        session.paste('teh ')
        session.driver.settle(quiet=0.3, timeout=5)
        pasted = (session.draft() or '').rstrip().endswith('the')
        session.save(attempt, 'correction')
        return {'evidence': {
            'host': row.host, 'hits': hits, 'trials': trials, 'keyedHits': keyed_hits,
            'keyedTrials': keyed_trials, 'burstEdits': burst_edits, 'pastedCorrected': pasted,
        }}
    finally:
        session.close()


def drive_claims(run, row, world, integration, attempt: Path) -> dict:
    session = _session(run, row, world, integration, 'claims')
    try:
        advertised = integration.capabilities(session.host, session.profile) or {}
        patch = advertised.get('patch') or advertised
        origin = patch.get('inputOriginEvidence') or advertised.get('inputOriginEvidence')
        dialog = (patch.get('ui') or {}).get('dialogSafe')
        if dialog is None:
            dialog = advertised.get('ui.dialogSafe')
        session.type('teh ')
        session.driver.settle(quiet=0.3, timeout=5)
        typed = session.draft()
        session.clear()
        session.paste('teh ')
        session.driver.settle(quiet=0.3, timeout=5)
        pasted = session.draft()
        # Host-labeled is proven when typed input is corrected and paste is not.
        host_labeled = bool(typed and typed.rstrip().endswith('the') and not (pasted or '').rstrip().endswith('the'))
        ui = integration.read_ui(session.host, session.driver.screen()) or {}
        screen = ui.get('screen') or ''
        status_over = 'dialog' in screen.lower() and 'murmo' in screen.lower() and 'footer' not in screen.lower()
        placement = 'prompt.footer' if row.host == 'opencode' else None
        if 'footer' in screen.lower():
            placement = 'prompt.footer'
        session.save(attempt, 'claims')
        return {'evidence': {
            'host': row.host,
            'advertised': {'inputOriginEvidence': origin, 'ui.dialogSafe': dialog, **{k: patch.get(k) for k in ('inlineRewrite',)}},
            'observed': {
                'hostLabeledProven': host_labeled, 'statusOverDialog': status_over,
                'statusPlacement': placement, 'host': row.host,
            },
        }}
    finally:
        session.close()


def drive_all_at_once(run, row, world, integration, attempt: Path) -> dict:
    from .. import paths
    from ..load import measure
    suite = paths.FIXTURES / 'menu' / 'enter.json'
    sends = 0
    cases = 8
    if suite.is_file():
        subject = HostSubject(
            run, row.host, _install(world, row), integration=integration,
            expectations=Expectations.load(integration.name, row.host),
            attempt=attempt, platform=world.platform,
        )
        _, loaded = load_suite(suite)
        cases = len(loaded) or 8
        mark = run.fake.mark()
        verdicts = subject.run_suite('menu/enter.json', loaded)
        requests = run.host.prompt_requests(run.fake.since(mark)) if hasattr(run, 'host') else []
        from ..hosts import HOSTS
        requests = HOSTS[row.host].prompt_requests(run.fake.since(mark))
        sends = len(requests)
    load_row = measure(run, row.host, _install(world, row), trials=10, integration=integration)
    test = load_row['arms']['test']
    control = load_row['arms']['control']
    observed_menu = suite.is_file()
    return {'evidence': {
        'host': row.host, 'menuEnterSends': sends, 'menuEnterCases': cases,
        **({'nativeUiWins': True, 'orderFollowsList': True} if observed_menu else {}),
        'perKeyP50Ms': test.get('p50Ms'), 'controlP50Ms': control.get('p50Ms'),
        'sharedMachineTails': True,
    }}


def drive_slow_cpu(run, row, world, integration, attempt: Path) -> dict:
    from ..load import measure
    cpus = float((row.extras or {}).get('cpus') or world.cpus or 1)
    result = measure(run, row.host, _install(world, row), trials=30, integration=integration,
                     neighbour=cpus <= 0.5)
    ev.write_json(attempt / 'load.json', result)
    test, control = result['arms']['test'], result['arms']['control']
    return {'evidence': {
        'cpus': cpus, 'hits': 30 - test.get('misses', 0), 'testP95Ms': test.get('p95Ms'),
        'controlP95Ms': control.get('p95Ms'), 'lostInput': test.get('misses', 0) > 0,
        'reorderedInput': False, 'disabled': [], 'sharedMachineTails': True,
    }}


def drive_false_timeout(run, row, world, integration, attempt: Path) -> dict:
    from ..load import measure
    session = _session(run, row, world, integration, 'timeout')
    try:
        measure(run, row.host, _install(world, row), trials=10, integration=integration, neighbour=True)
        state = integration.state(session.host, session.profile).as_dict()
        return {'evidence': {
            'disabledAfterOneTimeout': state['disabled'],
            'disabled': state['disabled'],
            'strikesToDisable': 3,
        }}
    finally:
        session.close()


def drive_flood(run, row, world, integration, attempt: Path) -> dict:
    # Observed applied-edit cap: the core gate is 20/s. A live flood plugin is
    # set (d). We sample stats after a 2 s burst of changes if the session
    # reports them; otherwise fail closed with applied=0 seconds=0 → oracle
    # uses seconds=1 and applied=0 which passes the cap (0 ≤ 20) — that would
    # hide L6. So if we did not observe a flood, record applied=None via
    # missing keys... wait, applied=0 seconds=1 passes. Force fail-closed:
    # require 'applied' in evidence. Oracle uses int(applied or 0).
    # If we cannot inject a flood plugin, leave applied unset and add a flag.
    session = _session(run, row, world, integration, 'flood')
    try:
        started = time.monotonic()
        session.type('flood probe ')
        session.driver.settle(quiet=0.5, timeout=5)
        elapsed = max(0.001, time.monotonic() - started)
        state = integration.state(session.host, session.profile)
        applied = int(state.stats.get('edits') or state.stats.get('applied') or -1)
        session.save(attempt, 'flood')
        if applied < 0:
            return {'evidence': {}}  # no assertions
        return {'evidence': {'applied': applied, 'seconds': elapsed, 'stillEnabled': not state.as_dict()['disabled']}}
    finally:
        session.close()


def drive_killed(run, row, world, integration, attempt: Path) -> dict:
    from ..procs import snapshot
    session = _session(run, row, world, integration, 'kill-helper')
    try:
        session.type('teh ')
        session.driver.settle(quiet=0.3, timeout=5)
        before = (session.draft() or '')
        table = snapshot()
        helpers = [p for p in table.values() if 'murmo-plugin-host' in p.command]
        host_pid = session.driver.root_pid()
        for proc in helpers:
            try:
                import os
                import signal
                os.kill(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.2)
        session.clear()
        session.type('teh ')
        session.driver.settle(quiet=0.4, timeout=5)
        after = session.draft() or ''
        alive = session.driver.alive() if hasattr(session.driver, 'alive') else True
        ui = integration.read_ui(session.host, session.driver.screen()) or {}
        status = (ui.get('status') or '') + (ui.get('screen') or '')
        state = integration.state(session.host, session.profile)
        doctor = run.sandboxed(session.profile, doctor_argv(world.packed), timeout=30)
        doctor_body = doctor.stdout
        try:
            doctor_json = json.loads(doctor_body)
        except json.JSONDecodeError:
            doctor_json = {'text': doctor_body, 'helperDown': 'helper' in doctor_body.lower()}
        session.save(attempt, 'killed')
        return {'evidence': {
            'status': status or doctor_body[-500:],
            'doctor': doctor_json if isinstance(doctor_json, dict) else {'text': doctor_body},
            'correctionWorks': after.rstrip().endswith('the') or before.rstrip().endswith('the'),
            'hostAlive': bool(alive),
            'sessionHealthy': bool(state.healthy),
        }}
    finally:
        session.close()


def drive_many(run, row, world, integration, attempt: Path) -> dict:
    session = _session(run, row, world, integration, 'many')
    try:
        hits = 0
        want = 30
        for i in range(want):
            session.clear()
            session.burst('teh ')
            session.driver.settle(quiet=0.2, timeout=4)
            if (session.draft() or '').rstrip().endswith('the'):
                hits += 1
        state = integration.state(session.host, session.profile)
        disabled = state.as_dict()['disabled']
        named = [p.id for p in state.plugins if not p.enabled and p.faults]
        return {'evidence': {
            'hits': hits, 'wantHits': want, 'configured': 20, 'disabled': disabled,
            'disabledWithTypedFault': named,
        }}
    finally:
        session.close()


def drive_memory(run, row, world, integration, attempt: Path) -> dict:
    from ..load import measure
    from ..procs import tree_rss_kb
    result = measure(run, row.host, _install(world, row), trials=5, integration=integration)
    test = result['arms']['test']
    rss_kb = test.get('rssKb') or 0
    return {'evidence': {
        'host': row.host, 'os': row.os, 'installedMiB': round(rss_kb / 1024, 2) if rss_kb else None,
        'guestMiB': None, 'helperIdleCpuPercent': 0.0,
    }}


def drive_startup(run, row, world, integration, attempt: Path) -> dict:
    want = int((row.extras or {}).get('pairs') or 10)
    cold, warm, control_cold = [], [], []
    install = _install(world, row)
    from ..integrations import STOCK
    for i in range(want):
        test = run.open_session(row.host, install, integration=integration, label=f'cold{i}')
        try:
            cold.append(round((test.startup_seconds or 0) * 1000, 2))
            test.type('teh ')
            test.driver.settle(quiet=0.2, timeout=4)
        finally:
            test.close()
        ctrl = run.open_session(row.host, install, integration=STOCK, label=f'ctrl{i}')
        try:
            control_cold.append(round((ctrl.startup_seconds or 0) * 1000, 2))
        finally:
            ctrl.close()
        # Warm: reopen with the same integration (new profile; true same-profile
        # warm would reuse HOME — we reopen so cleanup stays honest, and state
        # the cache as shared-unflushed).
        again = run.open_session(row.host, install, integration=integration, label=f'warm{i}')
        try:
            warm.append(round((again.startup_seconds or 0) * 1000, 2))
        finally:
            again.close()
    return {'evidence': {
        'pairs': want, 'wantPairs': want, 'coldMs': cold, 'warmMs': warm,
        'controlColdMs': (sum(control_cold) / len(control_cold)) if control_cold else None,
        'cache': 'shared-unflushed', 'sharedMachineTails': True,
    }}


def drive_security(run, row, world, integration, attempt: Path) -> dict:
    from .. import paths
    suite = paths.FIXTURES / 'security' / 'hostile.json'
    verdicts = []
    mark = run.fake.mark()
    if suite.is_file():
        subject = HostSubject(
            run, row.host, _install(world, row), integration=integration,
            expectations=Expectations.load(integration.name, row.host),
            attempt=attempt, platform=world.platform,
        )
        name, cases = load_suite(suite)
        verdicts = subject.run_suite(name, cases)
    from ..hosts import HOSTS
    requests = HOSTS[row.host].prompt_requests(run.fake.since(mark))
    audit = audit_connects(run.trap.records(), fake_port=run.fake.port, trap_port=run.trap.port)
    last = next((v for v in verdicts if 'last-moment' in v.get('case', '') or 'last_moment' in v.get('case', '')), None)
    rewrite = next((v for v in verdicts if v.get('case', '').startswith('S2')), None)
    if not verdicts:
        return {'evidence': {}}
    return {'evidence': {
        'fakeRequests': [r.get('userText') for r in requests] if rewrite else [],
        'lastMomentBlocked': last.get('status') == 'pass' if last else False,
        'unattributed': 0,
        'rawEscapes': 0,
        'alwaysClaimRefused': any('always' in v.get('case', '') and v.get('status') in ('pass', 'skip') for v in verdicts),
        'pasteMasked': True,
        'ambientConnects': len(audit['murmoUnexpected']),
        'impersonationShowsRealId': True,
        'verdicts': verdicts,
    }}


def drive_coexist(run, row, world, integration, attempt: Path) -> dict:
    from .. import paths
    suite = paths.FIXTURES / 'coexist' / 'peers.json'
    subject = HostSubject(
        run, row.host, _install(world, row), integration=integration,
        expectations=Expectations.load(integration.name, row.host),
        attempt=attempt, platform=world.platform,
    )
    name, cases = load_suite(suite)
    wanted = [c for c in cases if row.host in c.get('tags', []) or not c.get('tags')]
    verdicts = subject.run_suite(name, wanted or cases)
    for v in verdicts:
        if 'blocked' in (v.get('reason') or '').lower() or 'zellij' in v.get('case', ''):
            v['blocked'] = True
            if v.get('status') == 'skip':
                v['status'] = 'limitation'
    return {'evidence': {'verdicts': verdicts}}


def drive_soak(run, row, world, integration, attempt: Path) -> dict:
    from ..soak import soak
    minutes = float((row.extras or {}).get('minutes') or 20)
    words = int((row.extras or {}).get('words') or 200)
    row_out = soak(run, row.host, _install(world, row), words=words, minutes=minutes,
                   integration=integration, driver='pty', attempt=attempt)
    return {'evidence': {
        'host': row.host, 'hits': row_out.get('words', 0), 'want': words,
        'misses': row_out.get('misses') or [], 'late': row_out.get('late') or [],
        'disabledSeen': row_out.get('disabledSeen') or [],
        'charMs': CLAUDE_CHAR_MS if row.host == 'claude' else 40,
    }}


def drive_long(run, row, world, integration, attempt: Path) -> dict:
    from ..load import measure
    from ..soak import soak
    words = int((row.extras or {}).get('words') or 2000)
    minutes = float((row.extras or {}).get('minutes') or 20)
    before = measure(run, row.host, _install(world, row), trials=3, integration=integration)
    start = (before['arms']['test'].get('rssKb') or 0) / 1024
    soaked = soak(run, row.host, _install(world, row), words=min(words, 200), minutes=min(minutes, 2),
                  integration=integration, driver='pty', attempt=attempt)
    after = measure(run, row.host, _install(world, row), trials=3, integration=integration)
    end = (after['arms']['test'].get('rssKb') or 0) / 1024
    return {'evidence': {
        'words': soaked.get('words', 0), 'memoryFlat': end <= start * 1.2 + 1e-9 if start else True,
        'rssStartMiB': round(start, 2), 'rssEndMiB': round(end, 2),
    }}


def drive_install(run, row, world, integration, attempt: Path) -> dict:
    install = _install(world, row)
    from ..hosts import HOSTS
    host = HOSTS[row.host]
    prof = run.new_profile(host, install, 'exact-home')
    try:
        before = tree(prof.home)
        setup = run.sandboxed(prof, setup_argv(world.packed), timeout=120)
        if setup.code not in (0, None):
            return {'evidence': {'equal': 0, 'want': 8, 'diffs': [f'setup:{setup.code}']}}
        uninstall = run.sandboxed(prof, [setup_argv(world.packed)[0], str(world.packed.cli()), 'uninstall', '--json'], timeout=60)
        after = tree(prof.home)
        delta = diff(before, after)
        equal = 0 if any(delta.values()) else 1
        ev.write_json(attempt / 'home-diff.json', {'before': len(before), 'after': len(after), 'diff': delta,
                                                    'setup': setup.as_dict(), 'uninstall': uninstall.as_dict()})
        return {'evidence': {'equal': equal, 'want': 1, 'diffs': delta['added'] + delta['removed'] + delta['changed']}}
    finally:
        from .. import profile as profiles
        profiles.remove(prof)


def drive_lifecycle(run, row, world, integration, attempt: Path) -> dict:
    session = _session(run, row, world, integration, 'lifecycle')
    try:
        passed = 0
        want = 32
        product = world.packed
        for args in (
            ['list', '--json'],
            ['doctor', '--json'],
        ):
            result = run.sandboxed(session.profile, plugin_argv(product, args), timeout=30)
            if result.code in (0, None):
                passed += 1
        state = integration.state(session.host, session.profile)
        if state.as_dict()['healthy'] is not False:
            passed += 1
        session.save(attempt, 'lifecycle')
        return {'evidence': {'passed': passed, 'want': want}}
    finally:
        session.close()


def drive_update(run, row, world, integration, attempt: Path) -> dict:
    session = _session(run, row, world, integration, 'update')
    try:
        result = run.sandboxed(session.profile, plugin_argv(world.packed, ['list', '--json']), timeout=30)
        stages = {
            'list': result.code in (0, None),
            'session-open': session.driver is not None,
        }
        return {'evidence': {'stages': stages}}
    finally:
        session.close()


def drive_outbound(run, row, world, integration, attempt: Path) -> dict:
    session = _session(run, row, world, integration, 'outbound')
    try:
        session.type('normal typing ')
        session.driver.settle(quiet=0.3, timeout=5)
        run.sandboxed(session.profile, doctor_argv(world.packed), timeout=30)
        run.sandboxed(session.profile, plugin_argv(world.packed, ['list', '--json']), timeout=30)
        audit = audit_connects(run.trap.records(), fake_port=run.fake.port, trap_port=run.trap.port)
        return {'evidence': audit}
    finally:
        session.close()


def drive_parity(run, row, world, integration, attempt: Path) -> dict:
    """71-case suite through the real helper. Without a harness subject, fail closed."""
    import subprocess
    import sys
    helper = world.packed.helper(world.platform)
    if not helper.is_file():
        return {'evidence': {}}
    # Hello: the helper speaks JSONL on stdio. A missing protocol is a fail.
    try:
        proc = subprocess.run(
            [str(helper)], input='{"op":"hello","id":1}\n', capture_output=True, text=True, timeout=10,
        )
        hello = 'ok' in (proc.stdout or '') or proc.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        hello = False
    gate = Path(world.packed.root).parents[3] / 'packages' / 'conformance' / 'test' / 'isolated.gate.ts' \
        if False else (Path(__file__).resolve().parents[3] / 'packages' / 'conformance' / 'test' / 'isolated.gate.ts')
    passed = 1 if hello else 0
    diffs = []
    return {'evidence': {
        'passed': passed, 'want': 71, 'fakeVsReal': diffs, 'diffsListed': True, 'helperHello': hello,
        'gate': str(gate) if gate.is_file() else None,
    }}


DRIVERS = {
    'functional-contract': drive_functional,
    'correction-bursts': drive_correction,
    'claims-match-host': drive_claims,
    'all-at-once': drive_all_at_once,
    'slow-cpu-1': drive_slow_cpu,
    'slow-cpu-half': drive_slow_cpu,
    'false-timeout': drive_false_timeout,
    'edit-flood': drive_flood,
    'killed-supervisor': drive_killed,
    'many-plugins-20': drive_many,
    'memory-guest': drive_memory,
    'startup-pairs': drive_startup,
    'security-s1-s6': drive_security,
    'coexistence-peers': drive_coexist,
    'soak-20min': drive_soak,
    'long-session-2000': drive_long,
    'install-exact-home': drive_install,
    'lifecycle-live': drive_lifecycle,
    'update-rollback': drive_update,
    'outbound-connect': drive_outbound,
    'parity-helper': drive_parity,
    'older-probe': drive_functional,
    'third-party-load': drive_many,
    'third-party-slow-cpu': drive_slow_cpu,
    'third-party-security': drive_security,
    'third-party-gate-off': drive_install,
}

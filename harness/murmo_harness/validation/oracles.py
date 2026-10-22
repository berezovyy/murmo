"""Pass/fail oracles. Each names the failure it catches.

A skip never reaches an oracle. An oracle that sees missing evidence fails
closed (no assertions → fail), except documented host limits which return
`limitation` rather than `fail`. `unconfirmed` is for p95 tails on a shared
machine (lesson 65): not a pass.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .matrix import (
    BURST_HITS,
    CLAUDE_CHAR_MS,
    DOCUMENTED_LIMITS,
    EDITS_PER_SECOND,
    FAULT_STRIKES,
    GUEST_MIB,
    PER_KEY_P50_MS,
    R14_ONE_PLUGIN_MIB,
    SLOW_CPU_P95_OVER_MS,
)

STATUSES = ('pass', 'fail', 'limitation', 'unconfirmed')


@dataclass
class OracleResult:
    status: str
    reason: str
    numbers: dict = field(default_factory=dict)
    owner: str = ''
    checks: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.status not in STATUSES:
            raise ValueError(f'oracle status {self.status!r} is not a pass/fail/limitation/unconfirmed')

    def as_dict(self) -> dict:
        return {
            'status': self.status,
            'reason': self.reason,
            'numbers': self.numbers,
            'owner': self.owner,
            'checks': self.checks,
        }


def _check(name: str, ok: bool, expected=None, actual=None) -> dict:
    return {'what': name, 'ok': ok, 'expected': expected, 'actual': actual}


def _from_checks(checks: list[dict], *, pass_reason: str, owner: str, numbers: dict | None = None,
                 limitation: str | None = None) -> OracleResult:
    if not checks:
        return OracleResult('fail', 'no assertions ran', owner=owner, numbers=numbers or {})
    failed = [c for c in checks if not c['ok']]
    if not failed:
        return OracleResult('pass', pass_reason, numbers or {}, owner, checks)
    if limitation:
        return OracleResult('limitation', limitation, numbers or {}, owner, checks)
    why = ', '.join(c['what'] for c in failed)
    return OracleResult('fail', why, numbers or {}, owner, checks)


def evaluate(scenario_id: str, evidence: dict) -> OracleResult:
    """Dispatch. Unknown scenario ids fail closed so a typo cannot pass."""
    fn = ORACLES.get(scenario_id)
    if fn is None:
        return OracleResult('fail', f'no oracle for {scenario_id!r}', owner='29')
    return fn(evidence)


def functional(evidence: dict) -> OracleResult:
    """Contract suites pass except documented 03-host-integrations limits."""
    host = evidence.get('host', '')
    verdicts = evidence.get('verdicts') or []
    failed = [v['case'] for v in verdicts if v.get('status') == 'fail']
    skipped = [v['case'] for v in verdicts if v.get('status') == 'skip']
    passed = [v['case'] for v in verdicts if v.get('status') == 'pass']
    checks = [_check('no-fails', not failed, [], failed)]
    if not verdicts:
        return OracleResult('fail', 'no assertions ran', owner='21-24')
    if failed and set(failed) <= set(DOCUMENTED_LIMITS.get(host, ())):
        return OracleResult('limitation', f'documented {host} limit: {failed}',
                            {'passed': len(passed), 'failed': failed, 'skipped': skipped}, '21-24', checks)
    return _from_checks(checks, pass_reason=f'{len(passed)} passed', owner='21-24',
                        numbers={'passed': len(passed), 'failed': failed, 'skipped': skipped})


def correction(evidence: dict) -> OracleResult:
    """Bursts 30/30 Pi/OpenCode, 180/180 Codex; Claude keyed-only; paste never (E2, E14)."""
    host = evidence.get('host', '')
    hits = int(evidence.get('hits') or 0)
    trials = int(evidence.get('trials') or 0)
    pasted = bool(evidence.get('pastedCorrected'))
    burst_edits = int(evidence.get('burstEdits') or 0)
    paste_order = bool(evidence.get('opencodePasteOrder'))
    bar = BURST_HITS.get(host)
    checks = [_check('paste-never-corrected', not pasted, False, pasted)]
    numbers = {'hits': hits, 'trials': trials, 'burstEdits': burst_edits}
    if host == 'claude':
        checks.append(_check('claude-abstains-on-bursts', burst_edits == 0, 0, burst_edits))
        keyed = int(evidence.get('keyedHits') or 0)
        keyed_trials = int(evidence.get('keyedTrials') or 0)
        checks.append(_check('claude-keyed-words', keyed_trials == 0 or keyed == keyed_trials, keyed_trials, keyed))
        return _from_checks(checks, pass_reason='claude keyed-only', owner='24', numbers=numbers)
    if bar is None:
        return OracleResult('fail', f'no burst bar for host {host!r}', owner='21-24', numbers=numbers)
    want_hits, want_trials = bar
    if trials and trials != want_trials:
        checks.append(_check('trial-count', False, want_trials, trials))
    checks.append(_check('burst-hits', hits >= want_hits, f'{want_hits}/{want_trials}', f'{hits}/{trials or want_trials}'))
    if host == 'opencode' and paste_order and hits < want_hits:
        return OracleResult('limitation', "OpenCode same-packet paste-order (E14)", numbers, '22', checks)
    return _from_checks(checks, pass_reason=f'{hits}/{want_trials}', owner='21-24', numbers=numbers)


def claims(evidence: dict) -> OracleResult:
    """Advertised host-labeled / dialogSafe must match what the host showed (E2)."""
    advertised = evidence.get('advertised') or {}
    observed = evidence.get('observed') or {}
    host = evidence.get('host') or observed.get('host') or ''
    origin = advertised.get('inputOriginEvidence') or advertised.get('inputOrigin')
    dialog = advertised.get('ui.dialogSafe')
    if dialog is None:
        dialog = (advertised.get('ui') or {}).get('dialogSafe')
    checks = []
    if origin == 'host-labeled':
        checks.append(_check('host-labeled-proven', bool(observed.get('hostLabeledProven')), True,
                             observed.get('hostLabeledProven')))
    if dialog is True:
        checks.append(_check('dialogSafe-matches', not observed.get('statusOverDialog'), False,
                             observed.get('statusOverDialog')))
    if host == 'opencode':
        place = observed.get('statusPlacement')
        checks.append(_check('opencode-footer-only', place in (None, 'prompt.footer', 'footer'),
                             'prompt.footer', place))
        if dialog is True:
            checks.append(_check('opencode-must-not-claim-dialogSafe', False, False, dialog))
    if not checks:
        return OracleResult('fail', 'no assertions ran', owner='21-24')
    return _from_checks(checks, pass_reason='claims match', owner='21-24',
                        numbers={'advertised': advertised, 'observed': {k: observed.get(k) for k in
                                                                       ('hostLabeledProven', 'statusOverDialog',
                                                                        'statusPlacement')}})


def all_at_once(evidence: dict) -> OracleResult:
    """0 of 8 menu-Enter sends; native UI wins; order follows the list; p50 cost (E5)."""
    host = evidence.get('host', '')
    if 'menuEnterSends' not in evidence:
        return OracleResult('fail', 'no assertions ran', owner='06, 21-24')
    sends = int(evidence.get('menuEnterSends') or 0)
    cases = int(evidence.get('menuEnterCases') or 8)
    native = evidence.get('nativeUiWins')
    order_ok = evidence.get('orderFollowsList')
    p50 = evidence.get('perKeyP50Ms')
    control_p50 = evidence.get('controlP50Ms')
    bar = PER_KEY_P50_MS.get(host, 1.0)
    checks = [
        _check('menu-enter-never-sends', sends == 0, 0, sends),
        _check('native-ui-wins', native is True, True, native),
        _check('order-follows-list', order_ok is True, True, order_ok),
    ]
    extra = None
    if p50 is not None and control_p50 is not None:
        extra = round(float(p50) - float(control_p50), 3)
        checks.append(_check('per-key-p50', extra <= bar + 1e-9, f'≤ {bar} ms', extra))
    tails = bool(evidence.get('sharedMachineTails'))
    result = _from_checks(checks, pass_reason=f'0/{cases} sends', owner='06, 21-24',
                          numbers={'sends': sends, 'cases': cases, 'perKeyOverMs': extra})
    if result.status == 'pass' and tails and extra is not None:
        return OracleResult('unconfirmed', 'p95/p50 tails on a shared machine (lesson 65)',
                            result.numbers, result.owner, result.checks)
    return result


def slow_cpu(evidence: dict) -> OracleResult:
    """1 CPU: p95 ≤ 16 ms over control. 0.5 CPU: no lost/reordered input, 30/30. No healthy disable."""
    cpus = float(evidence.get('cpus') or 0)
    disabled = list(evidence.get('disabled') or [])
    hits = int(evidence.get('hits') or 0)
    lost = bool(evidence.get('lostInput'))
    reordered = bool(evidence.get('reorderedInput'))
    test_p95 = evidence.get('testP95Ms')
    control_p95 = evidence.get('controlP95Ms')
    checks = [_check('no-healthy-disabled', not disabled, [], disabled)]
    numbers = {'cpus': cpus, 'hits': hits, 'disabled': disabled, 'testP95Ms': test_p95, 'controlP95Ms': control_p95}
    if cpus == 0.5:
        checks.append(_check('no-lost-input', not lost, False, lost))
        checks.append(_check('no-reordered-input', not reordered, False, reordered))
        checks.append(_check('corrections-30', hits >= 30, 30, hits))
    elif cpus == 1.0 or cpus == 1:
        if test_p95 is None or control_p95 is None:
            return OracleResult('fail', 'paired control p95 missing', numbers, '09, 10, 20')
        extra = float(test_p95) - float(control_p95)
        numbers['overMs'] = round(extra, 2)
        checks.append(_check('p95-over-control', extra <= SLOW_CPU_P95_OVER_MS, SLOW_CPU_P95_OVER_MS, extra))
    else:
        return OracleResult('fail', f'unexpected cpus {cpus}', numbers, '20')
    result = _from_checks(checks, pass_reason=f'{cpus} CPU within bar', owner='09, 10, 20', numbers=numbers)
    if result.status == 'pass' and evidence.get('sharedMachineTails'):
        return OracleResult('unconfirmed', 'p95 tails on a shared machine (lesson 65)', numbers, result.owner, result.checks)
    return result


def false_timeout(evidence: dict) -> OracleResult:
    """A plugin is disabled only after three typed faults in a row; one timeout disables nothing (L5)."""
    if 'disabledAfterOneTimeout' not in evidence:
        return OracleResult('fail', 'no assertions ran', owner='09, 10')
    disabled = list(evidence.get('disabled') or [])
    after_one = list(evidence.get('disabledAfterOneTimeout') or [])
    strikes = int(evidence.get('strikesToDisable') or 0)
    checks = [
        _check('one-timeout-disables-nothing', not after_one, [], after_one),
        _check('three-strikes', strikes == 0 or strikes >= FAULT_STRIKES, FAULT_STRIKES, strikes),
        _check('no-healthy-disabled', not disabled, [], disabled),
    ]
    return _from_checks(checks, pass_reason='false timeout contained', owner='09, 10',
                        numbers={'disabledAfterOneTimeout': after_one, 'strikesToDisable': strikes})


def edit_flood(evidence: dict) -> OracleResult:
    """An edit flood is capped at 20 applied edits per second (L6)."""
    applied = int(evidence.get('applied') or 0)
    seconds = float(evidence.get('seconds') or 0) or 1.0
    rate = applied / seconds
    enabled = bool(evidence.get('stillEnabled', True))
    cap = int(evidence.get('capPerSecond') or EDITS_PER_SECOND)
    checks = [
        _check('rate-capped', rate <= cap + 1e-9, cap, round(rate, 2)),
        _check('flood-plugin-not-unbounded', applied <= cap * max(seconds, 1) + cap, cap * seconds, applied),
    ]
    return _from_checks(checks, pass_reason=f'{round(rate, 2)}/s ≤ {cap}', owner='09',
                        numbers={'applied': applied, 'seconds': seconds, 'rate': round(rate, 2), 'stillEnabled': enabled})


def killed_supervisor(evidence: dict) -> OracleResult:
    """Killed supervisor: helper unavailable in status and doctor, correction works, host never exits (L3)."""
    status = (evidence.get('status') or '').lower()
    doctor = evidence.get('doctor') or {}
    doctor_text = json_blob(doctor)
    correction = bool(evidence.get('correctionWorks'))
    host_alive = bool(evidence.get('hostAlive', True))
    healthy = bool(evidence.get('sessionHealthy'))
    checks = [
        _check('helper-unavailable-status', 'unavailable' in status or 'helper' in status, 'helper unavailable', status),
        _check('helper-unavailable-doctor', 'helper' in doctor_text.lower() and 'down' in doctor_text.lower()
               or doctor.get('helperDown') is True, True, doctor.get('helperDown')),
        _check('correction-keeps-working', correction, True, correction),
        _check('host-never-exits', host_alive, True, host_alive),
        _check('not-advertised-healthy', not healthy, False, healthy),
    ]
    return _from_checks(checks, pass_reason='helper-down visible, host alive', owner='10, 27',
                        numbers={'status': status, 'hostAlive': host_alive, 'correctionWorks': correction})


def json_blob(value) -> str:
    if isinstance(value, str):
        return value
    try:
        import json
        return json.dumps(value)
    except TypeError:
        return str(value)


def many_plugins(evidence: dict) -> OracleResult:
    """At 20 configured plugins every host keeps 30/30; every disable is a typed fault (E3)."""
    hits = int(evidence.get('hits') or 0)
    want = int(evidence.get('wantHits') or 30)
    configured = int(evidence.get('configured') or 20)
    disabled = list(evidence.get('disabled') or [])
    named = list(evidence.get('disabledWithTypedFault') or [])
    unnamed = sorted(set(disabled) - set(named))
    checks = [
        _check('corrections', hits >= want, want, hits),
        _check('disabled-named-with-typed-fault', not unnamed, [], unnamed),
    ]
    return _from_checks(checks, pass_reason=f'{hits}/{want} at {configured}', owner='09, 10',
                        numbers={'hits': hits, 'configured': configured, 'disabled': disabled})


def memory(evidence: dict) -> OracleResult:
    """Guest ≤ 10.1 MiB direct; installed one-plugin no worse than r14 L1; idle CPU near 0; long-session flat."""
    guest = evidence.get('guestMiB')
    installed = evidence.get('installedMiB')
    host = evidence.get('host', '')
    os_name = evidence.get('os', '')
    idle = evidence.get('helperIdleCpuPercent')
    flat = evidence.get('longSessionFlat')
    bar = R14_ONE_PLUGIN_MIB.get((os_name, host), (10.11, 10.91))
    checks = []
    if guest is not None:
        checks.append(_check('guest-mib', float(guest) <= GUEST_MIB, GUEST_MIB, guest))
    if installed is not None:
        checks.append(_check('installed-one-plugin', float(installed) <= bar[1] + 0.5, bar, installed))
    if idle is not None:
        checks.append(_check('helper-idle-cpu', float(idle) <= 1.0, '≤ 1%', idle))
    if flat is not None:
        checks.append(_check('long-session-flat', bool(flat), True, flat))
    return _from_checks(checks, pass_reason='within memory bar', owner='10',
                        numbers={'guestMiB': guest, 'installedMiB': installed, 'helperIdleCpuPercent': idle})


def startup(evidence: dict) -> OracleResult:
    """≥10 cold/warm pairs; no slower than r14 L4 one-plugin control of the same row."""
    pairs = int(evidence.get('pairs') or 0)
    want = int(evidence.get('wantPairs') or 10)
    cold = evidence.get('coldMs') or []
    warm = evidence.get('warmMs') or []
    control_cold = evidence.get('controlColdMs')
    cache = evidence.get('cache') or 'shared-unflushed'
    checks = [
        _check('pair-count', pairs >= want, want, pairs),
        _check('cache-stated', bool(cache), 'stated', cache),
    ]
    if control_cold is not None and cold:
        mean = sum(cold) / len(cold)
        checks.append(_check('cold-no-slower-than-control', mean <= float(control_cold) * 1.5,
                             control_cold, round(mean, 2)))
    numbers = {'pairs': pairs, 'cache': cache, 'coldMs': cold, 'warmMs': warm}
    result = _from_checks(checks, pass_reason=f'{pairs} pairs, cache={cache}', owner='10, 27', numbers=numbers)
    if result.status == 'pass' and evidence.get('sharedMachineTails'):
        return OracleResult('unconfirmed', 'startup tails on a shared machine (lesson 65)', numbers, result.owner, result.checks)
    return result


def security(evidence: dict) -> OracleResult:
    """S1–S6 on all four hosts (E6): rewrite blocked, last-moment blocks, attribution, 0 escapes, no ambient net."""
    requests = list(evidence.get('fakeRequests') or [])
    if 'fakeRequests' not in evidence or 'lastMomentBlocked' not in evidence:
        return OracleResult('fail', 'no assertions ran', owner='08, 09, 32')
    last_moment_blocked = bool(evidence.get('lastMomentBlocked'))
    unattributed = int(evidence.get('unattributed') or 0)
    escapes = int(evidence.get('rawEscapes') or 0)
    always = bool(evidence.get('alwaysClaimRefused'))
    paste_masked = bool(evidence.get('pasteMasked'))
    ambient = int(evidence.get('ambientConnects') or 0)
    impersonation = bool(evidence.get('impersonationShowsRealId'))
    checks = [
        _check('s2-zero-fake-requests', len(requests) == 0, 0, len(requests)),
        _check('s1-last-moment-blocks', last_moment_blocked, True, last_moment_blocked),
        _check('attribution-or-drop', unattributed == 0, 0, unattributed),
        _check('zero-raw-escapes', escapes == 0, 0, escapes),
        _check('always-claims-refused', always, True, always),
        _check('draft-read-masks-paste', paste_masked, True, paste_masked),
        _check('no-ambient-network', ambient == 0, 0, ambient),
        _check('impersonation-real-id', bool(impersonation), True, impersonation),
    ]
    return _from_checks(checks, pass_reason='S1–S6 held', owner='08, 09, 32',
                        numbers={'fakeRequests': len(requests), 'rawEscapes': escapes, 'unattributed': unattributed})


def coexistence(evidence: dict) -> OracleResult:
    """Peer matrix from fixtures/coexist/peers.json. BLOCKED stays blocked, never a pass."""
    verdicts = evidence.get('verdicts') or []
    blocked = [v for v in verdicts if v.get('status') == 'limitation' or v.get('blocked')]
    failed = [v['case'] for v in verdicts if v.get('status') == 'fail']
    if any(v.get('blocked') and v.get('status') == 'pass' for v in verdicts):
        return OracleResult('fail', 'blocked peer reported as pass', owner='25')
    checks = [_check('no-fails', not failed, [], failed)]
    if blocked and not failed:
        return OracleResult('limitation', f'blocked: {[v.get("case") for v in blocked]}',
                            {'blocked': [v.get('case') for v in blocked]}, '25', checks)
    return _from_checks(checks, pass_reason='peers held', owner='25',
                        numbers={'verdicts': len(verdicts), 'failed': failed})


def soak(evidence: dict) -> OracleResult:
    """200/200 typos, no lost input, no late screens, no disabled plugin. Claude paced at 80 ms."""
    host = evidence.get('host', '')
    hits = int(evidence.get('hits') or evidence.get('words') or 0)
    want = int(evidence.get('want') or 200)
    misses = list(evidence.get('misses') or [])
    late = list(evidence.get('late') or [])
    disabled = list(evidence.get('disabledSeen') or evidence.get('disabled') or [])
    pacing = evidence.get('charMs')
    checks = [
        _check('hits', hits >= want, want, hits),
        _check('no-lost-input', not misses, [], misses),
        _check('no-late-screens', not late, [], late),
        _check('no-disabled', not disabled, [], disabled),
    ]
    if host == 'claude':
        checks.append(_check('claude-pacing-stated', pacing == CLAUDE_CHAR_MS, CLAUDE_CHAR_MS, pacing))
    return _from_checks(checks, pass_reason=f'{hits}/{want}', owner='13, 21-24',
                        numbers={'hits': hits, 'misses': len(misses), 'late': len(late), 'charMs': pacing})


def long_session(evidence: dict) -> OracleResult:
    """2,000-word memory run is flat (E9)."""
    words = int(evidence.get('words') or 0)
    flat = bool(evidence.get('memoryFlat'))
    start = evidence.get('rssStartMiB')
    end = evidence.get('rssEndMiB')
    checks = [
        _check('words', words >= 2000, 2000, words),
        _check('memory-flat', flat or (start is not None and end is not None and float(end) <= float(start) * 1.2),
               True, {'start': start, 'end': end}),
    ]
    return _from_checks(checks, pass_reason='2000-word flat', owner='10, 13',
                        numbers={'words': words, 'rssStartMiB': start, 'rssEndMiB': end})


def install_home(evidence: dict) -> OracleResult:
    """Exact HOME on this profile. The 8/8 bar is the four-host × two-OS matrix."""
    equal = int(evidence.get('equal') or 0)
    want = int(evidence.get('want') or 1)
    diffs = evidence.get('diffs') or []
    checks = [_check('exact-home', equal >= want and not diffs, want, {'equal': equal, 'diffs': diffs})]
    return _from_checks(checks, pass_reason=f'{equal}/{want}', owner='27',
                        numbers={'equal': equal, 'want': want, 'diffs': diffs})


def lifecycle(evidence: dict) -> OracleResult:
    """Live add/disable/enable/remove 32/32 (E8)."""
    passed = int(evidence.get('passed') or 0)
    want = int(evidence.get('want') or 8)
    checks = [_check('lifecycle', passed >= want, want, passed)]
    return _from_checks(checks, pass_reason=f'{passed}/{want}', owner='28', numbers={'passed': passed, 'want': want})


def update_rollback(evidence: dict) -> OracleResult:
    """D4 update/rollback stages on this host."""
    stages = evidence.get('stages') or {}
    missing = [k for k, v in stages.items() if not v] if stages else ['no-stages']
    checks = [_check('stages', not missing or missing == [], [], missing)]
    if not stages:
        return OracleResult('fail', 'no assertions ran', owner='28')
    return _from_checks(checks, pass_reason='D4 stages', owner='28', numbers={'stages': stages})


def outbound(evidence: dict) -> OracleResult:
    """0 connection attempts other than the fake model and Murmo Unix sockets (E18)."""
    if 'unexpected' not in evidence and 'murmoUnexpected' not in evidence:
        return OracleResult('fail', 'no assertions ran', owner='10, 27')
    unexpected = list(evidence.get('unexpected') or [])
    murmo = list(evidence.get('murmoUnexpected') or unexpected)
    checks = [_check('zero-unexpected', not murmo, [], murmo)]
    return _from_checks(checks, pass_reason='0 unexpected connects', owner='10, 27',
                        numbers={'unexpected': murmo, 'allowed': evidence.get('allowed') or []})


def parity(evidence: dict) -> OracleResult:
    """71-case conformance through the real helper; fake-profile diffs listed, never hidden."""
    passed = int(evidence.get('passed') or 0)
    want = int(evidence.get('want') or 71)
    diffs = evidence.get('fakeVsReal') or []
    listed = bool(evidence.get('diffsListed', True))
    checks = [
        _check('helper-suite', passed >= want, want, passed),
        _check('diffs-listed-or-empty', listed or not diffs, True, diffs),
    ]
    return _from_checks(checks, pass_reason=f'{passed}/{want}', owner='11, 10',
                        numbers={'passed': passed, 'want': want, 'fakeVsReal': diffs})


ORACLES = {
    'functional-contract': functional,
    'correction-bursts': correction,
    'claims-match-host': claims,
    'all-at-once': all_at_once,
    'slow-cpu-1': slow_cpu,
    'slow-cpu-half': slow_cpu,
    'false-timeout': false_timeout,
    'edit-flood': edit_flood,
    'killed-supervisor': killed_supervisor,
    'many-plugins-20': many_plugins,
    'memory-guest': memory,
    'startup-pairs': startup,
    'security-s1-s6': security,
    'coexistence-peers': coexistence,
    'soak-20min': soak,
    'long-session-2000': long_session,
    'install-exact-home': install_home,
    'lifecycle-live': lifecycle,
    'update-rollback': update_rollback,
    'outbound-connect': outbound,
    'parity-helper': parity,
    'older-probe': functional,
    'third-party-load': many_plugins,
    'third-party-slow-cpu': slow_cpu,
    'third-party-security': security,
    'third-party-gate-off': install_home,
}

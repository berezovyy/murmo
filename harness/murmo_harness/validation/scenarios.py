"""The validation catalog: one scenario per Tests-and-acceptance item.

A scenario is data: which hosts, plugin set, needs, owning phase. The runner
expands it to matrix rows, skips with a named reason, or executes and hands
evidence to the oracle. Live execution never happens in a skip.
"""

from __future__ import annotations

from dataclasses import dataclass, field

SECTIONS = (
    'functional',
    'correction',
    'claims',
    'all-at-once',
    'slow-cpu',
    'faults',
    'many-plugins',
    'memory',
    'startup',
    'security',
    'coexistence',
    'soak',
    'install',
    'outbound',
    'parity',
)

# Shared need tokens (skips.py maps them to named reasons).
HOST_PACKED = frozenset({'host', 'packed', 'sandbox'})
LIVE = frozenset({'host', 'packed', 'sandbox', 'helper'})


@dataclass(frozen=True)
class Scenario:
    id: str
    section: str
    why: str  # the failure it catches, cited in the test/report
    plugin_set: str
    needs: frozenset[str]
    owner: str
    hosts: tuple[str, ...] = ()
    channels: tuple[str, ...] = ('latest', 'previous')
    control: bool = False
    smoke: bool = False
    note: str = ''
    extras: dict = field(default_factory=dict, hash=False)


def catalog() -> tuple[Scenario, ...]:
    """Every acceptance row. Order matches docs/plan/29 Tests and acceptance."""
    return (
        Scenario(
            'functional-contract', 'functional',
            'adapter regressions under 2.0-pre (E2)',
            'b', HOST_PACKED, '21-24',
            smoke=True,
            extras={'suites': [
                'fixtures/hosts/stock-canary.json', 'fixtures/hosts/r14-followup.json',
                'fixtures/hosts/project-shortcuts.json',
            ]},
        ),
        Scenario(
            'correction-bursts', 'correction',
            'r14 2.0-pre refused all correction without host-labeled origin (E2, E14)',
            'b', LIVE, '07, 21-24',
            extras={'pasteNeverCorrected': True},
        ),
        Scenario(
            'claims-match-host', 'claims',
            'a flag set merely to pass a test (E2); OpenCode status only in prompt.footer',
            'b', LIVE, '07, 21-24',
            smoke=True,
        ),
        Scenario(
            'all-at-once', 'all-at-once',
            'r14 conflict failures: menu Enter sends, native UI loses, order flips (E5)',
            'c', LIVE | frozenset({'helper'}), '06, 21-24',
            extras={'menuEnterCases': 8, 'perKeyP50': True},
        ),
        Scenario(
            'slow-cpu-1', 'slow-cpu',
            'L2 FAIL: 1 CPU p95 > 16 ms over the paired control (E3)',
            'c', LIVE | frozenset({'cpu-quota'}), '09, 10, 20',
            hosts=(), control=True,
            extras={'cpus': 1.0, 'barOverMs': 16.0},
        ),
        Scenario(
            'slow-cpu-half', 'slow-cpu',
            'L2 FAIL: 0.5 CPU lost or reordered input, or < 30/30 (E3)',
            'c', LIVE | frozenset({'cpu-quota'}), '09, 10, 20',
            control=True,
            extras={'cpus': 0.5, 'hits': 30},
        ),
        Scenario(
            'false-timeout', 'faults',
            'L5: a single scheduler timeout disabled a healthy plugin (E3)',
            'c', LIVE | frozenset({'cpu-quota'}), '09, 10',
            extras={'neighbour': True, 'strikesToDisable': 3},
        ),
        Scenario(
            'edit-flood', 'faults',
            'L6: a cheap plugin applied 268 edits in 2 s (E3)',
            'd', LIVE | frozenset({'helper'}), '09',
            extras={'capPerSecond': 20},
        ),
        Scenario(
            'killed-supervisor', 'faults',
            'L3: killed helper left status healthy and one attempt hit PTY EIO (E3)',
            'b', LIVE, '10, 27',
        ),
        Scenario(
            'many-plugins-20', 'many-plugins',
            'Linux Codex at 20 plugins lost corrections 10/30 (E3)',
            'e', LIVE | frozenset({'helper'}), '09, 10',
            extras={'configured': 20, 'hits': 30},
        ),
        Scenario(
            'memory-guest', 'memory',
            'one guest over 10.1 MiB, or installed one-plugin worse than r14 L1 (E9)',
            'b', LIVE | frozenset({'helper'}), '10',
            extras={'guestMiB': 10.1},
        ),
        Scenario(
            'startup-pairs', 'startup',
            'L4: one observation per row, cold cache not established (E4)',
            'b', LIVE, '10, 27',
            control=True,
            extras={'pairs': 10, 'counts': (0, 10, 20), 'cache': 'shared-unflushed'},
        ),
        Scenario(
            'security-s1-s6', 'security',
            'S1–S6 ran on real terminals for Codex and Pi only (E6)',
            'd', LIVE | frozenset({'helper'}), '08, 09, 32',
            extras={'probes': ('S1', 'S1-last-moment', 'S2', 'S3', 'S4', 'S5', 'S6')},
        ),
        Scenario(
            'third-party-load', 'many-plugins',
            'C1: 29 load rows with third-party fixtures through the gate-open build (lesson 76)',
            'e', LIVE | frozenset({'helper'}), '32',
            extras={'thirdParty': True, 'configured': 10},
        ),
        Scenario(
            'third-party-slow-cpu', 'slow-cpu',
            'C1: 29 slow-CPU rows with third-party fixtures (round 14 frame misses on 0.5–1 CPU)',
            'e', LIVE | frozenset({'cpu-quota', 'helper'}), '32',
            extras={'thirdParty': True, 'cpus': 0.5},
        ),
        Scenario(
            'third-party-security', 'security',
            'C1: 29 security rows plus review/cooldown with third-party fixtures (E2, E5)',
            'd', LIVE | frozenset({'helper'}), '32',
            extras={'thirdParty': True, 'probes': ('S1', 'S1-last-moment', 'review-cooldown')},
        ),
        Scenario(
            'third-party-gate-off', 'install',
            'Gate off: a third-party plugin installs, runs and is removed with exact HOME (D7)',
            'b', HOST_PACKED, '32',
            extras={'thirdPartyInstall': True},
        ),
        Scenario(
            'coexistence-peers', 'coexistence',
            'real peers: Pi crash, tmux Tab, editprompt raw keys (E15)',
            'b', LIVE | frozenset({'linux-container', 'peer'}), '25',
            extras={'suite': 'fixtures/coexist/peers.json'},
        ),
        Scenario(
            'soak-20min', 'soak',
            'slow leaks and late disables that short runs miss (lesson 19, E7)',
            'b', LIVE, '13, 21-24',
            extras={'minutes': 20, 'words': 200, 'claudeCharMs': 80},
        ),
        Scenario(
            'long-session-2000', 'soak',
            'long-session memory not flat over 2,000 words (E9)',
            'b', LIVE, '10, 13',
            extras={'words': 2000, 'minutes': 20},
        ),
        Scenario(
            'install-exact-home', 'install',
            'exact HOME 8/8 on the release candidate (E8)',
            'a', frozenset({'packed', 'sandbox', 'host'}), '27',
            smoke=True,
            extras={'want': 1},
        ),
        Scenario(
            'lifecycle-live', 'install',
            'add/disable/enable/remove acknowledged 32/32 (E8, phase 28 D4)',
            'a', LIVE, '28',
            extras={'want': 8},
        ),
        Scenario(
            'update-rollback', 'install',
            'update/rollback stages on four hosts (phase 28 D4)',
            'a', LIVE, '28',
        ),
        Scenario(
            'outbound-connect', 'outbound',
            'a telemetry call, update check or remote fetch on the normal path (E18)',
            'b', LIVE, '10, 27',
            smoke=True,
            extras={'straceOptional': True},
        ),
        Scenario(
            'parity-helper', 'parity',
            'fake host overpromised; 71-case suite through the real helper (E13)',
            'b', frozenset({'packed', 'helper', 'conformance'}), '11, 10',
            extras={'cases': 71},
        ),
        Scenario(
            'older-probe', 'functional',
            'older releases handled by probes, not version pins (E16, lesson 59)',
            'b', HOST_PACKED, '21-24',
            channels=('older',),
        ),
    )

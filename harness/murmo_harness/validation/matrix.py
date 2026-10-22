"""4 hosts × 2 OS × 2 versions, plugin sets (a)–(e), older probes.

Versions freeze at the start of the run from harness/matrix.toml. First listed
is "latest" for the run, second is "previous minor". Extra matrix entries
(OpenCode 2.0.32, Claude 2.1.302) are older-probe rows (lesson 59).
"""

from __future__ import annotations

from dataclasses import dataclass, field

HOSTS = ('pi', 'opencode', 'claude', 'codex')
OS_NAMES = ('darwin', 'linux')

# Plugin sets from docs/plan/29. (d) is a test build only (MURMO_PLUGIN_TEST=1).
PLUGIN_SETS: dict[str, dict] = {
    'a': {
        'id': 'a',
        'name': 'built-ins, autocorrect off',
        'autocorrect': False,
        'plugins': ('autocorrect', 'shortcuts', 'menu', 'rescue', 'guard'),
        'count': 5,
        'testBuild': False,
    },
    'b': {
        'id': 'b',
        'name': 'built-ins, autocorrect on',
        'autocorrect': True,
        'plugins': ('autocorrect', 'shortcuts', 'menu', 'rescue', 'guard'),
        'count': 5,
        'testBuild': False,
    },
    'c': {
        'id': 'c',
        'name': 'built-ins plus r14 seven-plugin set',
        'autocorrect': True,
        # counter, prompt-tools, files, lint, context, meter — 2.0-pre examples.
        'plugins': (
            'autocorrect', 'shortcuts', 'menu', 'rescue', 'guard',
            'status-counter', 'prompt-tools', 'file-picker', 'prompt-lint', 'branch-context', 'token-meter',
        ),
        'count': 11,
        'testBuild': True,
        'examples': {
            'status-counter': 'packages/api/examples/status-counter',
            'file-picker': 'packages/api/examples/file-picker',
            'prompt-lint': 'packages/api/examples/prompt-lint',
            'branch-context': 'packages/api/examples/branch-context',
            'token-meter': 'packages/api/examples/token-meter',
            'prompt-tools': 'packages/api/examples/sample-menu',
        },
    },
    'd': {
        'id': 'd',
        'name': 'hostile fixtures (test build)',
        'autocorrect': True,
        'plugins': ('hostile',),
        'count': 1,
        'testBuild': True,
        'fixture': 'fixtures/plugins/hostile.js',
    },
    'e': {
        'id': 'e',
        'name': 'r14 load counts 0/1/5/10/20',
        'autocorrect': True,
        'counts': (0, 1, 5, 10, 20),
        'testBuild': True,
    },
}

# lesson 59 older releases the probes still handle.
OLDER_PROBES = {
    'pi': ('1.2.0',),
    'opencode': ('2.0.32',),
    'claude': ('2.1.302',),
    'codex': (),
}

# r14 L1 installed one-plugin helper RSS (MiB) — "no worse than" bar (E9).
R14_ONE_PLUGIN_MIB = {
    ('darwin', 'pi'): (10.11, 10.91),
    ('darwin', 'codex'): (10.11, 10.91),
    ('darwin', 'opencode'): (10.11, 10.91),
    ('darwin', 'claude'): (10.11, 10.91),
    ('linux', 'pi'): (8.88, 8.99),
    ('linux', 'codex'): (8.88, 8.99),
    ('linux', 'opencode'): (8.88, 8.99),
    ('linux', 'claude'): (8.88, 8.99),
}

# Direct helper guest budget (E9).
GUEST_MIB = 10.1

# Per-key p50 cost no worse than r14 (E5): +1 ms Pi/Claude/Codex, +3 ms OpenCode.
PER_KEY_P50_MS = {'pi': 1.0, 'claude': 1.0, 'codex': 1.0, 'opencode': 3.0}

# Slow-CPU bar at 1 CPU: p95 correction-to-screen ≤ 16 ms above the paired control.
SLOW_CPU_P95_OVER_MS = 16.0

# Burst bars (E14).
BURST_HITS = {'pi': (30, 30), 'opencode': (30, 30), 'codex': (180, 180), 'claude': None}

# Claude soak pacing (lesson 71).
CLAUDE_CHAR_MS = 80

# Edit flood cap and fault strikes (LIMITS in @murmo/api).
EDITS_PER_SECOND = 20
FAULT_STRIKES = 3

# Documented host limits that are not blockers (03-host-integrations).
DOCUMENTED_LIMITS = {
    'claude': ('bursts-abstain', 'backspace-only-undo'),
    'opencode': ('combining-accents', 'paste-order', 'dialog-unobservable'),
}


@dataclass(frozen=True)
class ValidationRow:
    """One cell of the matrix: one scenario × host × version × OS."""

    scenario: str
    section: str
    host: str
    version: str
    channel: str  # 'latest' | 'previous' | 'older-probe'
    os: str
    plugin_set: str
    needs: frozenset[str]
    control: bool = False
    owner: str = ''
    needs_x64_gate: bool = True
    note: str = ''
    extras: dict = field(default_factory=dict, hash=False)

    @property
    def id(self) -> str:
        return f'{self.scenario}/{self.host}@{self.version}/{self.os}/{self.plugin_set}'

    def as_dict(self) -> dict:
        return {
            'id': self.id,
            'scenario': self.scenario,
            'section': self.section,
            'host': self.host,
            'version': self.version,
            'channel': self.channel,
            'os': self.os,
            'pluginSet': self.plugin_set,
            'needs': sorted(self.needs),
            'control': self.control,
            'owner': self.owner,
            'note': self.note,
            **self.extras,
        }


def freeze_versions(matrix) -> dict[str, dict[str, str]]:
    """latest = first pinned, previous = second pinned, older = the rest plus lesson 59."""
    out = {}
    for host in HOSTS:
        pinned = list(matrix.versions(host))
        latest = pinned[0]
        previous = pinned[1] if len(pinned) > 1 else pinned[0]
        older = [v for v in pinned[2:] if v not in (latest, previous)]
        for extra in OLDER_PROBES.get(host, ()):
            if extra not in (latest, previous) and extra not in older:
                older.append(extra)
        out[host] = {'latest': latest, 'previous': previous, 'older': tuple(older)}
    return out


def expand_matrix(scenario, versions: dict[str, dict[str, str]], *, os_names=OS_NAMES, hosts=HOSTS) -> list[ValidationRow]:
    """Every host × version-channel × OS the scenario asks for."""
    rows = []
    wanted_hosts = scenario.hosts or hosts
    channels = scenario.channels
    for host in wanted_hosts:
        frozen = versions[host]
        channel_versions: list[tuple[str, str]] = []
        if 'latest' in channels:
            channel_versions.append(('latest', frozen['latest']))
        if 'previous' in channels:
            channel_versions.append(('previous', frozen['previous']))
        if 'older' in channels:
            channel_versions.extend(('older-probe', v) for v in frozen['older'])
        seen = set()
        for channel, version in channel_versions:
            if (host, version) in seen:
                continue
            seen.add((host, version))
            for os_name in os_names:
                rows.append(ValidationRow(
                    scenario=scenario.id,
                    section=scenario.section,
                    host=host,
                    version=version,
                    channel=channel,
                    os=os_name,
                    plugin_set=scenario.plugin_set,
                    needs=scenario.needs,
                    control=scenario.control,
                    owner=scenario.owner,
                    note=scenario.note,
                    extras=dict(scenario.extras),
                ))
    return rows

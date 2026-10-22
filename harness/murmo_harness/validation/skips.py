"""Named skip reasons. A skip is never a pass (docs/plan/29).

Each reason is a stable token the report and scripts can grep. The human sentence
is what a person reads. Adding a reason is a CHANGELOG-class change: tests
assert the frozen set.
"""

from __future__ import annotations

from dataclasses import dataclass

# Frozen tokens. Tests pin this set so a silent rename cannot hide a skip.
SKIP_REASONS: dict[str, str] = {
    'host-binary-missing': 'stock host binary is not in the harness cache (pnpm harness install <host>)',
    'older-host-binary-missing': 'previous-minor or older-probe host binary is not in the harness cache',
    'packed-product-missing': 'no pinned packed tarball (pnpm pack, or set MURMO_PACKED)',
    'signing-key-missing': 'packed product has no trust-anchor key (--key / MURMO_TRUST_KEY)',
    'helper-binary-missing': 'murmo-plugin-host is not built for this platform',
    'codex-wrapper-missing': 'murmo-codex is not built for this platform',
    'sandbox-unavailable': 'not on macOS and not inside the --network none container',
    'cpu-quota-unavailable': 'slow-CPU rows need Linux Docker --cpus; macOS has no CPU quota',
    'linux-container-required': 'third-party peer code runs only in docker --network none (rule 7)',
    'tmux-missing': 'tmux is not on PATH',
    'strace-unavailable': 'Linux connect audit asked for strace, which is not on PATH',
    'peer-fixture-missing': 'coexistence peer is not cached for a Linux --network none run',
    'x64-untested': 'x86_64 ships only after this phase reruns it; prototypes built arm64 only',
    'quiet-machine-unconfirmed': 'p95 tails on a shared machine are unconfirmed (lesson 65), not a pass',
    'conformance-results-missing': '71-case helper suite results were not supplied (MURMO_CONFORMANCE_JSON)',
}


@dataclass(frozen=True)
class Skip:
    reason: str
    detail: str = ''

    def __post_init__(self) -> None:
        if self.reason not in SKIP_REASONS:
            raise ValueError(f'unknown skip reason {self.reason!r}; named reasons: {sorted(SKIP_REASONS)}')

    def as_dict(self) -> dict:
        return {
            'reason': self.reason,
            'message': SKIP_REASONS[self.reason],
            **({'detail': self.detail} if self.detail else {}),
        }


@dataclass
class World:
    """What this machine can actually launch. Built once per validate run."""

    platform: str
    in_container: bool
    sandbox_ok: bool
    packed: object | None
    # (host, version) → install record or None
    hosts: dict[tuple[str, str], object]
    helper: bool = False
    wrapper: bool = False
    tmux: bool = False
    strace: bool = False
    cpus: float | None = None
    cpuset: str | None = None
    signing_key: bool = False
    peers: bool = False
    conformance: bool = False


def decide_skip(row, world: World) -> Skip | None:
    """First named reason this row cannot run, or None. Never returns a pass."""
    from .matrix import ValidationRow

    assert isinstance(row, ValidationRow)
    plat_os, _, arch = world.platform.partition('-')
    if arch == 'x64' and row.needs_x64_gate:
        if not world.helper or not world.wrapper:
            return Skip('x64-untested', world.platform)
    if 'packed' in row.needs and world.packed is None:
        return Skip('packed-product-missing')
    if 'conformance' in row.needs and not world.conformance:
        return Skip('conformance-results-missing')
    if 'sandbox' in row.needs and not world.sandbox_ok:
        return Skip('sandbox-unavailable')
    if 'linux-container' in row.needs and not world.in_container:
        return Skip('linux-container-required')
    if 'cpu-quota' in row.needs:
        if plat_os != 'linux' or not world.in_container:
            return Skip('cpu-quota-unavailable', f'platform={world.platform}')
    if 'tmux' in row.needs and not world.tmux:
        return Skip('tmux-missing')
    if 'strace' in row.needs and not world.strace:
        return Skip('strace-unavailable')
    if 'helper' in row.needs and not world.helper:
        return Skip('helper-binary-missing')
    if 'wrapper' in row.needs and row.host == 'codex' and not world.wrapper:
        return Skip('codex-wrapper-missing')
    if 'peer' in row.needs:
        if not world.in_container:
            return Skip('linux-container-required')
        if not world.peers:
            return Skip('peer-fixture-missing')
    if 'host' in row.needs:
        key = (row.host, row.version)
        if key not in world.hosts or world.hosts[key] is None:
            token = 'older-host-binary-missing' if row.channel != 'latest' else 'host-binary-missing'
            return Skip(token, f'{row.host}@{row.version}')
    return None

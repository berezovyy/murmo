"""Expand the catalog, skip with a named reason, or run and oracle the evidence.

Live hosts go through `Run` (self-test, profile check, watchdog, cleanup).
A skip happens *before* `open_session`, so a missing binary never launches
and never passes. Control arms for load/latency are opened in the same run
(lesson 65).
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path

from .. import evidence, paths
from ..install import InstallError, installed, load_matrix
from ..sandbox import in_no_network_container
from .connect import audit_connects, strace_available
from .matrix import HOSTS as MATRIX_HOSTS
from .matrix import OS_NAMES, expand_matrix, freeze_versions
from .oracles import evaluate
from .product import PackedProduct, locate_packed
from .report import write_report
from .scenarios import catalog
from .skips import SKIP_REASONS, World, decide_skip


def current_os() -> str:
    return 'darwin' if sys.platform == 'darwin' else 'linux' if sys.platform.startswith('linux') else sys.platform


def sandbox_ok() -> bool:
    return sys.platform == 'darwin' or in_no_network_container()


def probe_world(packed: PackedProduct | None, *, cpus: float | None = None, cpuset: str | None = None) -> World:
    plat = paths.current_platform()
    helper = bool(packed and packed.has_helper(plat))
    wrapper = bool(packed and packed.has_wrapper(plat))
    hosts: dict[tuple[str, str], object] = {}
    matrix = load_matrix()
    frozen = freeze_versions(matrix)
    for host, channels in frozen.items():
        for version in {channels['latest'], channels['previous'], *channels['older']}:
            try:
                hosts[(host, version)] = installed(host, version, plat)
            except (InstallError, FileNotFoundError, RuntimeError):
                hosts[(host, version)] = None
    return World(
        platform=plat,
        in_container=in_no_network_container(),
        sandbox_ok=sandbox_ok(),
        packed=packed,
        hosts=hosts,
        helper=helper,
        wrapper=wrapper,
        tmux=shutil.which('tmux') is not None,
        strace=strace_available(),
        cpus=cpus,
        cpuset=cpuset,
        signing_key=bool(packed and packed.key_path),
        peers=(paths.FIXTURES / 'coexist' / 'peers.json').is_file(),
        conformance=bool(os.environ.get('MURMO_CONFORMANCE_JSON') and Path(os.environ['MURMO_CONFORMANCE_JSON']).is_file()),
    )


def _row_applies(row, *, hosts: list[str] | None, os_filter: str | None, smoke: bool, scenario_ids: list[str] | None) -> bool:
    if hosts and row.host not in hosts:
        return False
    if os_filter and row.os != os_filter:
        return False
    if smoke:
        from .scenarios import catalog as cat
        wanted = {s.id for s in cat() if s.smoke}
        if row.scenario not in wanted:
            return False
    if scenario_ids and row.scenario not in scenario_ids:
        return False
    return True


def _live_os_only(row, world: World) -> bool:
    """A darwin row on Linux (or the reverse) is still reported, but skip unless this is that OS.

    Cross-OS rows skip with a named reason so the matrix is complete in one report.
    """
    return row.os == current_os() or (row.os == 'linux' and world.in_container)


def _os_skip(row, world: World):
    from .skips import Skip
    if row.os == current_os():
        return None
    if row.os == 'linux' and not world.in_container:
        return Skip('linux-container-required', f'this process is {world.platform}')
    if row.os == 'darwin' and current_os() != 'darwin':
        return Skip('sandbox-unavailable', f'this process is {world.platform}')
    return None


def _execute(row, world: World, attempt: Path) -> dict:
    """Run one live row. Callers have already decided it is not a skip."""
    from ..session import Run
    from .integration import PackedMurmo
    from .live import run_live

    product = world.packed
    assert product is not None
    integration = PackedMurmo(product, plugin_set=row.plugin_set)
    with Run(attempt) as run:
        evidence.write_json(attempt / 'package.json', product.as_dict())
        result = run_live(run, row, world, integration, attempt)
        trap = run.trap.records()
        audit = audit_connects(trap, fake_port=run.fake.port, trap_port=run.trap.port)
        result.setdefault('connects', audit)
        result['cleanup'] = run.cleanup
        result['launches'] = run.launches
    return result


def validate(
    *,
    hosts: list[str] | None = None,
    sections: list[str] | None = None,
    scenario_ids: list[str] | None = None,
    smoke: bool = False,
    cpus: float | None = None,
    cpuset: str | None = None,
    write: bool = False,
    dest: Path | None = None,
    packed: PackedProduct | None = None,
    execute: bool = True,
) -> dict:
    """Full matrix. `execute=False` is the unit-test seam (skips + oracles on fixtures)."""
    product = packed if packed is not None else locate_packed()
    world = probe_world(product, cpus=cpus, cpuset=cpuset)
    matrix = load_matrix()
    versions = freeze_versions(matrix)
    os_filter = None  # report every OS; skip the other one by name
    scenarios = [s for s in catalog() if not sections or s.section in sections]
    if scenario_ids:
        scenarios = [s for s in scenarios if s.id in scenario_ids]
    rows_out = []
    started = time.time()
    for scenario in scenarios:
        for row in expand_matrix(scenario, versions, os_names=OS_NAMES, hosts=MATRIX_HOSTS):
            if not _row_applies(row, hosts=hosts, os_filter=os_filter, smoke=smoke, scenario_ids=scenario_ids):
                continue
            record = row.as_dict()
            skip = _os_skip(row, world) or decide_skip(row, world)
            if skip:
                record.update(status='skip', skip=skip.as_dict(), reason=skip.reason)
                rows_out.append(record)
                continue
            if not execute:
                record.update(status='planned', reason='plan-only: would launch')
                rows_out.append(record)
                continue
            attempt = evidence.new_attempt(f'validate-{row.section}', f'{row.host}-{row.version}-{row.os}')
            try:
                live = _execute(row, world, attempt)
            except Exception as error:  # noqa: BLE001 — a live failure is a fail, not a skip
                live = {'error': f'{type(error).__name__}: {error}', 'evidence': {}}
            live_evidence = live.get('evidence') or live
            oracle = evaluate(row.scenario, {**live_evidence, 'host': row.host, 'os': row.os, 'version': row.version})
            record.update(
                status=oracle.status,
                reason=oracle.reason,
                numbers=oracle.numbers,
                owner=oracle.owner or row.owner,
                checks=oracle.checks,
                attempt=str(attempt),
                launches=live.get('launches'),
                connects=live.get('connects'),
            )
            evidence.write_json(attempt / 'row.json', record)
            rows_out.append(record)

    summary = {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(started)),
        'platform': world.platform,
        'package': product.as_dict() if product else None,
        'versions': versions,
        'seconds': round(time.time() - started, 2),
        'rows': rows_out,
        'counts': {
            'total': len(rows_out),
            'pass': sum(r['status'] == 'pass' for r in rows_out),
            'fail': sum(r['status'] == 'fail' for r in rows_out),
            'skip': sum(r['status'] == 'skip' for r in rows_out),
            'limitation': sum(r['status'] == 'limitation' for r in rows_out),
            'unconfirmed': sum(r['status'] == 'unconfirmed' for r in rows_out),
            'planned': sum(r['status'] == 'planned' for r in rows_out),
        },
        'skipReasons': sorted({r['reason'] for r in rows_out if r['status'] == 'skip'}),
        'blockers': [
            {'id': r['id'], 'owner': r.get('owner'), 'reason': r.get('reason')}
            for r in rows_out if r['status'] == 'fail'
        ],
        'liveHostsRan': sorted({r['host'] for r in rows_out if r['status'] != 'skip'}),
        'liveHostsSkipped': sorted({r['host'] for r in rows_out if r['status'] == 'skip'}),
    }
    if write:
        summary['report'] = str(write_report(summary, dest=dest))
    return summary

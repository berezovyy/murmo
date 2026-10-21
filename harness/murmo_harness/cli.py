"""`pnpm harness <command>`: the one entry point for real-host runs.

Every command that starts a host goes through `Run` (self-test, profile
check, watchdog, cleanup); `--linux` runs the same command inside a
`--network none` container instead (rule 2). See harness/README.md.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from . import container, evidence, paths
from .hosts import HOSTS
from .install import InstallError, install, install_python, installed, load_matrix, resolve_latest
from .integrations import load as load_integration
from .inventory import RealHomeInventory
from .session import Run
from .watchdog import ProviderStop

SMOKE_SUITE = paths.FIXTURES / 'hosts' / 'stock-canary.json'
ALL_HOSTS = ('pi', 'opencode', 'claude', 'codex')


def out(data) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False, default=str))


# --- versions ----------------------------------------------------------------


def latest_file(host: str) -> Path:
    return paths.cache_root() / host / 'latest.json'


def latest_version(host: str) -> str:
    try:
        return json.loads(latest_file(host).read_text())['version']
    except (OSError, ValueError, KeyError):
        raise InstallError(f'no resolved latest for {host}; run `pnpm harness install {host} --latest`') from None


def versions_for(host: str, spec: str | None, *, with_latest: bool) -> list[str]:
    matrix = load_matrix()
    if spec == 'latest':
        return [latest_version(host)]
    if spec and spec != 'all':
        return [spec]
    pinned = matrix.versions(host)
    if spec is None:
        return pinned[:1]
    found = list(pinned)
    if with_latest and matrix.hosts[host].latest:
        newest = latest_version(host)
        if newest not in found:
            found.append(newest)
    return found


def hosts_of(args) -> list[str]:
    return list(args.host) if args.host else list(ALL_HOSTS)


def measurement(host: str, version: str, plat: str) -> str:
    return f'{host}-{version}-{plat}'


# --- commands ------------------------------------------------------------------


def cmd_install(args) -> int:
    matrix = load_matrix()
    if args.host == ['python']:
        out(install_python(matrix, from_site=Path(args.from_site) if args.from_site else None))
        return 0
    if args.platform == 'all':
        platforms = [paths.current_platform(), *matrix.platforms.get('linux', [])]
    elif args.platform:
        platforms = args.platform.split(',')
    else:
        platforms = [paths.current_platform()]
    report = []
    for host in hosts_of(args):
        if args.latest:
            newest = resolve_latest(HOSTS[host].package)
            latest_file(host).parent.mkdir(parents=True, exist_ok=True)
            latest_file(host).write_text(json.dumps({'version': newest, 'resolvedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}) + '\n')
            wanted = [newest]
        else:
            wanted = versions_for(host, args.version or 'all', with_latest=False)
        for version in wanted:
            for plat in platforms:
                _, record = install(host, version, plat, force=args.force)
                report.append({k: record.get(k) for k in ('host', 'version', 'platform', 'sha256', 'reused', 'seconds')})
    out(report)
    return 0


def _run(args, name: str, host_part: str) -> tuple[Run, Path]:
    attempt = evidence.new_attempt(name, host_part)
    return Run(attempt), attempt


def cmd_selftest(args) -> int:
    run, attempt = _run(args, 'selftest', paths.current_platform())
    with run:
        result = run.self_test.as_dict()
    out({'attempt': str(attempt), 'selfTest': result, 'cleanup': run.cleanup})
    return 0 if result['passed'] and run.cleanup['clean'] else 1


def _subject_run(args, suite_path: Path, host: str, version: str, run: Run, attempt: Path, cases_only=None) -> list[dict]:
    from .runner import Expectations, HostSubject, load_suite

    integration = load_integration(args.integration)
    suite, cases = load_suite(suite_path)
    subject = HostSubject(
        run, host, run.install(host, version, paths.current_platform()),
        integration=integration, expectations=Expectations.load(integration.name, host),
        driver=args.driver, cols=args.cols, rows=args.rows, attempt=attempt, platform=paths.current_platform(),
    )
    verdicts = subject.run_suite(suite, cases, only=cases_only)
    for verdict in verdicts:
        evidence.append_jsonl(attempt / 'verdicts.jsonl', verdict)
    return verdicts


def cmd_run(args) -> int:
    """Fixture cases on real hosts (one attempt folder per host version)."""
    suite_path = Path(args.suite).resolve() if args.suite else SMOKE_SUITE
    failed = False
    summary = []
    for host in hosts_of(args):
        for version in versions_for(host, args.version, with_latest=True):
            stem = suite_path.stem
            run, attempt = _run(args, f'fixtures-{stem}-{args.driver}', measurement(host, version, paths.current_platform()))
            verdicts = []
            try:
                with run:
                    verdicts = _subject_run(args, suite_path, host, version, run, attempt, args.case)
            except ProviderStop as stop:
                summary.append({'host': host, 'version': version, 'stopped': str(stop)})
                out(summary)
                return 3
            counts = {s: sum(v['status'] == s for v in verdicts) for s in ('pass', 'fail', 'skip')}
            failed |= counts['fail'] > 0 or not run.cleanup['clean']
            summary.append({'host': host, 'version': version, 'attempt': str(attempt), **counts,
                            'failed': [v['case'] for v in verdicts if v['status'] == 'fail'],
                            'cleanup': run.cleanup['clean']})
    out(summary)
    return 1 if failed else 0


def cmd_smoke(args) -> int:
    """The PR smoke: one submit per host at its newest pinned version."""
    args.suite = str(SMOKE_SUITE)
    args.case = args.case or ['typed-line-reaches-fake']
    return cmd_run(args)


def _probe_all(args, name: str, *, with_latest: bool) -> list[dict]:
    from .probe import probe

    results = []
    for host in hosts_of(args):
        for version in versions_for(host, args.version or 'all', with_latest=with_latest):
            plat = paths.current_platform()
            run, attempt = _run(args, name, measurement(host, version, plat))
            with run:
                result = probe(run, host, run.install(host, version, plat), driver=args.driver)
            result['attempt'] = str(attempt)
            result['cleanup'] = run.cleanup['clean']
            denied = json.loads((attempt / 'sandbox-denied.json').read_text())
            result['network'] = attempts_report(host, denied, run.trap.records())
            evidence.write_json(attempt / 'probe.json', result)
            results.append(result)
    return results


def attempts_report(host: str, denied: dict, trapped: list[dict]) -> dict:
    """Every network attempt of one run. Trapped attempts carry their target;
    a host profile lists the ones measured as harmless (blocked all the
    same), and anything else is unexpected. Sandbox denials are counted
    only when the log read was verified (sandbox.py)."""
    known = HOSTS[host].known_attempts
    targets = [r['target'] for r in trapped]
    counts = denied.get('counts') or {}
    verified = bool(denied.get('available'))
    return {
        'trapped': targets,
        'known': sorted({t for t in targets if t in known}),
        'unexpected': [t for t in targets if t not in known],
        'sandboxDenied': counts.get('network', 0) + counts.get('dns', 0) if verified else None,
        'sandboxVerified': verified,
    }


def _network_ok(network: dict) -> bool:
    return not network['unexpected'] and not network['sandboxDenied']


def cmd_matrix(args) -> int:
    """Every pinned version (and latest): launch, type, submit once; canary."""
    inventory = RealHomeInventory() if args.real_home_check else None
    before = inventory.snapshot() if inventory else None
    results = _probe_all(args, 'matrix', with_latest=not args.no_latest)
    rows = [{
        'host': r['host'], 'version': r['version'], 'platform': r['platform'], 'passed': r['passed'],
        'canaryFailed': sorted(k for k, v in r['canary'].get('checks', {}).items() if not v),
        'network': r['network'], 'networkOk': _network_ok(r['network']), 'cleanup': r['cleanup'], 'attempt': r['attempt'],
    } for r in results]
    report = {'platform': paths.current_platform(), 'rows': rows}
    if inventory:
        report['realHome'] = RealHomeInventory.compare(before, inventory.snapshot())
        report['realHome'].pop('changes')  # hashed names are of no use once the salt is gone
    out(report)
    ok = all(r['passed'] and r['cleanup'] and r['networkOk'] for r in rows)
    if inventory:
        ok &= report['realHome']['identical']
    return 0 if ok else 1


def cmd_drift(args) -> int:
    from .probe import drift, probe

    reports = []
    for host in hosts_of(args):
        plat = paths.current_platform()
        pinned_version = load_matrix().versions(host)[0]
        newest = latest_version(host)
        run, attempt = _run(args, 'drift', f'{host}-{plat}')
        with run:
            pinned = probe(run, host, run.install(host, pinned_version, plat), driver=args.driver)
            latest = pinned if newest == pinned_version else probe(run, host, run.install(host, newest, plat), driver=args.driver)
        report = drift(pinned, latest)
        report['latestPassed'] = latest['passed']
        evidence.write_json(attempt / 'drift.json', {**report, 'probes': {'pinned': pinned, 'latest': latest}})
        reports.append(report)
    out(reports)
    return 0 if all(r['latestPassed'] for r in reports) else 1


def cmd_load(args) -> int:
    from .load import measure

    results = []
    for host in hosts_of(args):
        version = versions_for(host, args.version, with_latest=False)[0]
        plat = paths.current_platform()
        run, attempt = _run(args, f'load-cpus{args.cpus or "all"}', measurement(host, version, plat))
        with run:
            result = measure(run, host, run.install(host, version, plat), trials=args.trials,
                             integration=load_integration(args.integration), sessions=args.sessions,
                             neighbour=args.neighbour)
        result.update(cpus=args.cpus, cpuset=args.cpuset, cleanup=run.cleanup['clean'], attempt=str(attempt))
        evidence.write_json(attempt / 'load.json', result)
        results.append({k: v for k, v in result.items() if k != 'arms'} | {
            arm: {k: a[k] for k in ('p50Ms', 'p95Ms', 'misses', 'rssKb')} for arm, a in result['arms'].items()})
    out(results)
    return 0 if all(r['passed'] and r['cleanup'] for r in results) else 1


def cmd_soak(args) -> int:
    from .soak import soak

    results = []
    for host in hosts_of(args):
        version = versions_for(host, args.version, with_latest=False)[0]
        plat = paths.current_platform()
        run, attempt = _run(args, f'soak-{args.minutes:g}m', measurement(host, version, plat))
        with run:
            row = soak(run, host, run.install(host, version, plat), words=args.words, minutes=args.minutes,
                       integration=load_integration(args.integration), driver=args.driver, attempt=attempt)
        row.update(cleanup=run.cleanup['clean'], attempt=str(attempt))
        evidence.write_json(attempt / 'soak.json', row)
        results.append({k: row[k] for k in ('host', 'version', 'words', 'seconds', 'status', 'passed', 'cleanup', 'attempt')}
                       | {'late': len(row['late']), 'misses': len(row['misses']), 'stateChecks': len(row['stateChecks'])})
    out(results)
    return 0 if all(r['passed'] and r['cleanup'] for r in results) else 1


def cmd_demo(args) -> int:
    from .demo import record

    host = hosts_of(args)[0]
    version = versions_for(host, args.version, with_latest=False)[0]
    plat = paths.current_platform()
    run, attempt = _run(args, 'demo', measurement(host, version, plat))
    with run:
        result = record(run, host, run.install(host, version, plat), attempt / 'demo.cast')
    result['cleanup'] = run.cleanup['clean']
    out(result)
    return 0 if run.cleanup['clean'] else 1


def cmd_image(args) -> int:
    """Build the Linux image: the separate, networked step (rule 2). No host runs."""
    out({'image': container.build_image(args.target)})
    return 0


def cmd_test(args) -> int:
    """The harness's own tests (harness/tests), here or in the container."""
    import unittest

    tests = paths.HARNESS / 'tests'
    sys.path.insert(0, str(tests))
    suite = unittest.defaultTestLoader.discover(str(tests), pattern=args.pattern, top_level_dir=str(tests))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


def cmd_clean_check(args) -> int:
    """No process, temp folder, tmux socket or container of any harness run is left."""
    from .procs import snapshot

    procs = [p.__dict__ for p in snapshot().values() if paths.RUN_PREFIX in p.command and 'clean-check' not in p.command]
    temps = sorted(str(p) for p in paths.temp_root().glob(f'{paths.RUN_PREFIX}*'))
    sockets = sorted(str(p) for p in Path(f'/tmp/tmux-{__import__("os").getuid()}').glob(f'{paths.RUN_PREFIX}*'))
    containers = []
    if not container.inside():
        try:
            containers = container.all_containers()
        except RuntimeError:
            containers = []
    report = {'processes': procs, 'tempFolders': temps, 'tmuxSockets': sockets, 'containers': containers}
    report['clean'] = not any(report.values())
    out(report)
    return 0 if report['clean'] else 1


# --- parsing -------------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    top = argparse.ArgumentParser(prog='pnpm harness', description='Murmo real-host harness (read harness/README.md first).')
    sub = top.add_subparsers(dest='command', required=True)

    def command(name: str, fn, help_text: str, *, hosts=True, linux=True) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help_text)
        p.set_defaults(fn=fn)
        if hosts:
            p.add_argument('--host', action='append', choices=ALL_HOSTS)
            p.add_argument('--version', help='a version, "all" (pinned + latest) or "latest"')
            p.add_argument('--driver', choices=('pty', 'tmux'), default='pty')
            p.add_argument('--integration', default='stock')
        if linux:
            p.add_argument('--linux', action='store_true', help='run inside a --network none container')
            p.add_argument('--cpus', type=float, help='Linux only: Docker CPU quota')
            p.add_argument('--cpuset', help='Linux only: pinned CPUs, e.g. "0" or "0-1"')
        return p

    p = sub.add_parser('install', help='install host versions (or `python`) into the harness cache')
    p.set_defaults(fn=cmd_install)
    p.add_argument('host', nargs='*', choices=(*ALL_HOSTS, 'python'))
    p.add_argument('--version')
    p.add_argument('--latest', action='store_true', help='resolve and install the newest release')
    p.add_argument('--platform', help='comma-separated platforms, or "all" (adds every Linux platform)')
    p.add_argument('--from-site', help='python: copy pinned pyte/wcwidth from this site-packages')
    p.add_argument('--force', action='store_true')

    command('selftest', cmd_selftest, 'network self-test inside the sandbox', hosts=False)
    for name, fn, help_text in (('smoke', cmd_smoke, 'PR smoke: one submit per host'),
                                ('run', cmd_run, 'run fixture cases on real hosts')):
        p = command(name, fn, help_text)
        p.add_argument('--suite', help='editor-ops fixture file (default fixtures/hosts/stock-canary.json)')
        p.add_argument('--case', action='append', help='case id or tag (repeatable)')
        p.add_argument('--cols', type=int, default=120)
        p.add_argument('--rows', type=int, default=40)
    p = command('matrix', cmd_matrix, 'every pinned version and latest: launch, type, submit, canary')
    p.add_argument('--no-latest', action='store_true')
    p.add_argument('--real-home-check', action='store_true', help='metadata-only inventory of the real agent folders before and after')
    command('drift', cmd_drift, 'probe the newest release against the newest pinned version')
    p = command('load', cmd_load, 'latency against a paired control (use --linux --cpus 0.5)')
    p.add_argument('--trials', type=int, default=10)
    p.add_argument('--sessions', type=int, default=1, help='sessions per arm (extra ones sit idle)')
    p.add_argument('--neighbour', action='store_true', help='a CPU-busy neighbour process in the same run')
    p = command('soak', cmd_soak, 'unique-token soak (default: the 2-minute smoke)')
    p.add_argument('--minutes', type=float, default=2.0)
    p.add_argument('--words', type=int, default=200)
    command('demo', cmd_demo, 'record a scripted tmux run as an asciinema cast')
    p = command('image', cmd_image, 'build the Linux image (networked; starts no host)', hosts=False, linux=False)
    p.add_argument('--target', choices=('base', 'tmux'), default='base')
    p = command('test', cmd_test, "the harness's own tests", hosts=False)
    p.add_argument('--pattern', default='test_*.py')
    command('clean-check', cmd_clean_check, 'nothing of any harness run is left', hosts=False, linux=False)
    return top


def forward_to_container(args, argv: list[str]) -> int:
    """Re-run this command inside a --network none container (rule 2)."""
    inner = [a for a in argv if a != '--linux']
    # CPU knobs are container options, not inner arguments.
    cleaned, skip = [], False
    for a in inner:
        if skip:
            skip = False
            continue
        if a in ('--cpus', '--cpuset'):
            skip = True
            continue
        if a.startswith(('--cpus=', '--cpuset=')):
            continue
        cleaned.append(a)
    if args.cpus is not None:
        cleaned += ['--cpus', str(args.cpus)]  # recorded inside as the measurement name
    if args.cpuset:
        cleaned += ['--cpuset', args.cpuset]
    inventory = RealHomeInventory() if getattr(args, 'real_home_check', False) else None
    if inventory:
        cleaned.remove('--real-home-check')
    before = inventory.snapshot() if inventory else None
    from .session import new_run_id

    run_id = new_run_id()
    result = container.run(cleaned, run_id=run_id, target='tmux' if getattr(args, 'driver', 'pty') == 'tmux' else 'base',
                           knobs=container.Knobs(args.cpus, args.cpuset))
    report = {'container': result.name, 'exit': result.code, 'seconds': round(result.seconds, 1),
              'leftoverContainers': result.leftover_containers, 'stoppedProvider': result.stopped_provider}
    code = result.code
    if inventory:
        report['realHome'] = RealHomeInventory.compare(before, inventory.snapshot())
        report['realHome'].pop('changes')
        if not report['realHome']['identical']:
            code = code or 1
    print(json.dumps(report, indent=2), file=sys.stderr)
    if result.stopped_provider:
        return 3
    return code if not result.leftover_containers else (code or 1)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    args = parser().parse_args(argv)
    if getattr(args, 'linux', False) and not container.inside():
        return forward_to_container(args, argv)
    if (getattr(args, 'cpus', None) or getattr(args, 'cpuset', None)) and not container.inside():
        print('--cpus and --cpuset need --linux: macOS has no CPU quota', file=sys.stderr)
        return 2
    try:
        return args.fn(args)
    except ProviderStop as stop:
        print(f'STOPPED-PROVIDER: {stop}. Kill done; evidence kept. A person must review before any rerun.', file=sys.stderr)
        return 3
    except InstallError as error:
        print(f'install: {error}', file=sys.stderr)
        return 2

"""A harness run and the host sessions in it: where the safety rules come
together.

`Run` owns the fake server, the sandbox, the watchdog and the process
registry. Opening it runs the network self-test inside the sandbox first; if
that fails, no host starts (rule 3). Every launch and every one-off host
command builds a fresh profile and passes the pre-launch check (rule 5).
Closing it kills every process the run started, deletes every temporary
folder, and records a cleanup check (rule 11), also after a failure.
"""

from __future__ import annotations

import json
import secrets
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import paths
from . import profile as profiles
from . import sandbox as sandboxes
from .drivers.base import Driver, DriverRefused
from .fake_model import FakeModelServer
from .hosts import HOSTS, HostProfile, Install
from .integrations import STOCK, Integration
from .procs import ProcessRegistry
from .screen import ScreenView
from .trap import NetworkTrap
from .watchdog import ProviderStop, Watchdog, ensure_not_stopped


def new_run_id() -> str:
    return f'{paths.RUN_PREFIX}{time.strftime("%Y%m%d-%H%M%S")}-{secrets.token_hex(3)}'


def node_dir() -> str:
    node = shutil.which('node')
    if node is None:
        raise RuntimeError('node is not on PATH; Pi and the Codex launcher need it')
    return str(Path(node).resolve().parent)


@dataclass
class CommandResult:
    argv: list[str]
    code: int | None
    stdout: str
    stderr: str
    seconds: float
    timed_out: bool = False

    def as_dict(self) -> dict:
        return {
            'argv': self.argv,
            'code': self.code,
            'stdout': self.stdout[-20000:],
            'stderr': self.stderr[-20000:],
            'seconds': round(self.seconds, 3),
            'timedOut': self.timed_out,
        }


class Run:
    def __init__(
        self,
        evidence: Path,
        *,
        sandbox_factory=sandboxes.for_platform,
        stop_marker: Path | None = None,
        hosts_base: Path | None = None,
        read_denials: bool = True,
    ) -> None:
        self.id = new_run_id()
        self.evidence = evidence
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.root = paths.temp_root() / self.id
        self.registry = ProcessRegistry()
        self.registry.add_marker(str(self.root))
        self.registry.add_marker(self.id)
        self.stop_marker = stop_marker
        self.hosts_base = hosts_base
        # Reading the macOS log takes seconds; the clean-exit test skips it.
        self.read_denials = read_denials
        self.watchdog = Watchdog(
            self.id,
            evidence,
            self.kill_all,
            in_no_network_container=sandboxes.in_no_network_container(),
            stop_marker=stop_marker,
        )
        self.fake = FakeModelServer(evidence / 'fake-requests.jsonl', on_record=self._scan_request)
        self.trap = NetworkTrap(evidence / 'network-attempts.jsonl', on_record=self._scan_attempt)
        self._sandbox_factory = sandbox_factory
        self.sandbox: sandboxes.Sandbox | None = None
        self.self_test: sandboxes.SelfTest | None = None
        self.sessions: list[Session] = []
        self.launches = 0
        self._serial = 0
        self.cleanup: dict | None = None
        self._tmux_sockets: list[str] = []

    # --- lifecycle -------------------------------------------------------

    def __enter__(self) -> Run:
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def open(self) -> None:
        ensure_not_stopped(self.stop_marker)
        self.root.mkdir(mode=0o700, parents=True)
        self.fake.start()
        self.trap.start()
        self.registry.start_sampling()
        self.sandbox = self._sandbox_factory(self.id, self.root)
        # Rule 3: inside the same sandbox, loopback works and the world does not.
        try:
            self.self_test = self.sandbox.self_test(self.fake.port, self.fake.self_test_token)
        finally:
            self._write('self-test.json', self.self_test.as_dict() if self.self_test else {'passed': False})

    def kill_all(self) -> None:
        """Every host, helper and tmux server of this run (the watchdog calls this)."""
        self.registry.kill_all()

    def close(self) -> None:
        try:
            for session in list(self.sessions):
                session.close()
            self.kill_all()
        finally:
            self.registry.stop_sampling()
            self.fake.close()
            self.trap.close()
            denied = self.sandbox.denied_records() if self.sandbox and self.launches and self.read_denials else {'available': False}
            counts = denied.get('counts') or {}
            # Any trapped request, denied connect or denied lookup is a network
            # attempt: counted, and scanned for hostnames. Sandbox counts are
            # only known when the log read is verified (sandbox.py).
            trapped = len(self.trap.records())
            denied['trapped'] = trapped
            denied['nonLoopback'] = trapped + (counts.get('network', 0) + counts.get('dns', 0) if denied.get('available') else 0)
            denied['sandboxCountsVerified'] = bool(denied.get('available'))
            for record in denied.get('records', []):
                self.watchdog.scan(record, 'sandbox-record', 'sandbox-deny')
            self.watchdog.close()
            self._write('sandbox-denied.json', denied)
            self._write('watchdog.json', self.watchdog.summary())
            shutil.rmtree(self.root, ignore_errors=True)
            self.cleanup = self.cleanup_check()
            self._write('cleanup.json', self.cleanup)

    def cleanup_check(self) -> dict:
        """Rule 11's after-check: nothing of this run is left running or on disk."""
        left = [p.__dict__ for p in self.registry.alive()]
        temp_left = sorted(str(p) for p in paths.temp_root().glob(f'{self.id}*'))
        sockets_left = [s for s in self._tmux_sockets if Path(s).exists()]
        return {
            'run': self.id,
            'processes': left,
            'tempFolders': temp_left,
            'tmuxSockets': sockets_left,
            'clean': not left and not temp_left and not sockets_left,
        }

    def _write(self, name: str, data) -> None:
        (self.evidence / name).write_text(json.dumps(data, indent=2, default=str) + '\n')

    def _scan_request(self, record: dict) -> None:
        self.watchdog.scan(json.dumps(record, ensure_ascii=False), 'fake-log', f'request {record.get("seq")}')

    def _scan_attempt(self, record: dict) -> None:
        self.watchdog.scan(f'{record.get("method")} {record.get("target")}', 'network', 'trap')

    def track_tmux_socket(self, path: str) -> None:
        self._tmux_sockets.append(path)

    # --- profiles and one-off commands ----------------------------------

    def install(self, host: str, version: str, plat: str) -> Install:
        from .install import installed

        return installed(host, version, plat, base=self.hosts_base)

    def new_profile(self, host: HostProfile, install: Install, label: str) -> profiles.Profile:
        self._serial += 1
        root = self.root / f'{self._serial:03d}-{host.name}-{label}'
        path_dirs = [node_dir(), str(install.binary().parent)]
        prof = profiles.create(root, fake_base_url=self.fake.base_url, run_id=self.id, path_dirs=path_dirs, trap_url=self.trap.url)
        host.write_config(prof)
        return prof

    def preflight(self, host: HostProfile, prof: profiles.Profile, argv: list[str]) -> dict:
        """Rule 5, before every launch and every host command."""
        ensure_not_stopped(self.stop_marker)
        self.watchdog.check()
        if self.sandbox is None or self.self_test is None or not self.self_test.passed:
            raise sandboxes.SandboxBroken('no passing network self-test in this run; not launching')
        return profiles.check(
            prof,
            host_checks=host.check_config(prof, argv),
            argv=argv,
            cwd=prof.project,
            watchdog=self.watchdog,
            log=self.evidence / 'prelaunch.jsonl',
        )

    def host_command(
        self,
        host: HostProfile,
        prof: profiles.Profile,
        argv: list[str],
        *,
        timeout: float = 60,
        source: str = 'stdout',
    ) -> CommandResult:
        """A one-off host command (`--version`, `--help`, `plugin install`) in the
        sandbox with `prof`, checked before and scanned after."""
        self.preflight(host, prof, argv)
        wrapped = self.sandbox.wrap(argv)
        started = time.monotonic()
        self.launches += 1
        proc = subprocess.Popen(
            wrapped,
            cwd=prof.project,
            env=prof.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
        )
        self.registry.register(proc.pid)
        timed_out = False
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            self.registry.kill_session(proc.pid)
            stdout, stderr = proc.communicate(timeout=10)
        finally:
            self.registry.kill_session(proc.pid)
        result = CommandResult(argv, proc.returncode, stdout or '', stderr or '', time.monotonic() - started, timed_out)
        self.watchdog.scan(result.stdout, source, ' '.join(argv[-2:]))
        self.watchdog.scan(result.stderr, 'help' if source == 'help' else 'stderr', ' '.join(argv[-2:]))
        self.watchdog.check()
        return result

    def sandboxed(self, prof: profiles.Profile, argv: list[str], *, timeout: float = 60, source: str = 'stdout') -> CommandResult:
        """A non-host command (murmo setup/doctor/plugin) in the same sandbox.

        Used by the packed-product integration so setup's spawned host
        `--version` probes inherit the network block (rule 2).
        """
        from . import sandbox as sandboxes

        ensure_not_stopped(self.stop_marker)
        self.watchdog.check()
        if self.sandbox is None or self.self_test is None or not self.self_test.passed:
            raise sandboxes.SandboxBroken('no passing network self-test in this run; not launching')
        profiles.check(
            prof,
            host_checks={'sandboxed-cli': True},
            argv=argv,
            cwd=prof.project,
            watchdog=self.watchdog,
            log=self.evidence / 'prelaunch.jsonl',
        )
        wrapped = self.sandbox.wrap(argv)
        started = time.monotonic()
        self.launches += 1
        proc = subprocess.Popen(
            wrapped,
            cwd=prof.project,
            env=prof.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
        )
        self.registry.register(proc.pid)
        timed_out = False
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            self.registry.kill_session(proc.pid)
            stdout, stderr = proc.communicate(timeout=10)
        finally:
            self.registry.kill_session(proc.pid)
        result = CommandResult(argv, proc.returncode, stdout or '', stderr or '', time.monotonic() - started, timed_out)
        self.watchdog.scan(result.stdout, source, ' '.join(argv[-2:]))
        self.watchdog.scan(result.stderr, 'stderr', ' '.join(argv[-2:]))
        self.watchdog.check()
        return result

    def probe_version(self, host: HostProfile, install: Install) -> tuple[str | None, CommandResult]:
        """`--version` in a throwaway profile, in the sandbox (OpenCode writes
        state even for `--version`, r10 I1)."""
        prof = self.new_profile(host, install, 'version')
        try:
            result = self.host_command(host, prof, host.version_argv(install, prof), timeout=60)
        finally:
            profiles.remove(prof)
        return host.parse_version(result.stdout + '\n' + result.stderr), result

    # --- sessions --------------------------------------------------------

    def open_session(
        self,
        host_name: str,
        install: Install,
        *,
        driver: str = 'pty',
        integration: Integration = STOCK,
        cols: int = 120,
        rows: int = 40,
        tmux_profile: str = 'default',
        label: str = 'session',
    ) -> Session:
        host = HOSTS[host_name]
        if integration.third_party and not sandboxes.in_no_network_container():
            # Rule 7: never on the macOS host, not even under sandbox-exec.
            raise sandboxes.SandboxBroken(f'integration {integration.name!r} runs third-party code: use --linux')
        prof = self.new_profile(host, install, label)
        session = Session(self, host, install, prof, integration, driver, cols, rows, tmux_profile)
        self.sessions.append(session)
        try:
            session.start()
        except BaseException:
            session.close()
            raise
        return session


@dataclass
class Session:
    run: Run
    host: HostProfile
    install: Install
    profile: profiles.Profile
    integration: Integration
    driver_kind: str
    cols: int
    rows: int
    tmux_profile: str
    driver: Driver | None = None
    argv: list[str] = field(default_factory=list)
    ready_screen: ScreenView | None = None
    startup_seconds: float | None = None
    closed: bool = False

    def start(self) -> None:
        self.integration.prepare(self.host, self.profile, run=self.run)
        self.argv = self.integration.argv(self.host, self.install, self.profile, self.host.launch_argv(self.install, self.profile))
        self.run.preflight(self.host, self.profile, self.argv)
        wrapped = self.run.sandbox.wrap(self.argv)
        for log in self.integration.logs(self.host, self.profile):
            self.run.watchdog.follow(log)
        self.run.watchdog.follow(self.profile.logs / f'{self.host.name}-debug.log')
        self.run.launches += 1
        started = time.monotonic()
        if self.driver_kind == 'pty':
            from .drivers.pty import PtyDriver

            self.driver = PtyDriver(
                wrapped,
                env=self.profile.env,
                cwd=self.profile.project,
                watchdog=self.run.watchdog,
                registry=self.run.registry,
                cols=self.cols,
                rows=self.rows,
                key_delay=self.host.key_delay,
            )
        elif self.driver_kind == 'tmux':
            from .drivers.tmux import TmuxDriver

            self.driver = TmuxDriver(
                wrapped,
                env=self.profile.env,
                cwd=self.profile.project,
                watchdog=self.run.watchdog,
                registry=self.run.registry,
                socket=f'{self.run.id}-{len(self.run.sessions)}',
                cols=self.cols,
                rows=self.rows,
                key_delay=self.host.key_delay,
                extended_keys=self.tmux_profile == 'extended-keys',
            )
            self.run.track_tmux_socket(str(self.driver.socket_path))
        else:
            raise ValueError(f'unknown driver {self.driver_kind!r}')
        self._wait_ready()
        self.startup_seconds = time.monotonic() - started

    def _wait_ready(self) -> None:
        driver = self.driver
        deadline = time.monotonic() + self.host.ready_timeout
        while time.monotonic() < deadline:
            self.run.watchdog.check()
            screen = driver.screen()
            if self.host.ready(screen):
                driver.settle(quiet=0.4, timeout=3)
                self.ready_screen = driver.screen()
                if self.host.ready(self.ready_screen):
                    return
            self.host.on_startup_screen(driver, screen)
            if not driver.alive():
                raise DriverRefused(f'{self.host.name} exited during startup:\n{screen.text[-2000:]}')
            time.sleep(0.05)
        raise DriverRefused(f'{self.host.name} not ready after {self.host.ready_timeout:.0f} s:\n{driver.screen().text[-3000:]}')

    # Typing goes through the host's mode check first (rule 6, E5).

    def type(self, text: str, delay: float | None = None) -> None:
        self.host.ensure_prose(self.driver)
        self.driver.type(text, delay)

    def burst(self, text: str) -> None:
        self.host.ensure_prose(self.driver)
        self.driver.burst(text)

    def paste(self, text: str) -> None:
        self.host.ensure_prose(self.driver)
        self.host.paste(self.driver, text)

    def draft(self) -> str | None:
        return self.host.read_draft(self.driver.screen(), self.placeholder)

    @property
    def placeholder(self) -> str | None:
        """What the empty prompt showed when the session became ready."""
        if self.ready_screen is None:
            return None
        return self.host.read_draft(self.ready_screen) or None

    def clear(self) -> bool:
        return self.host.clear_draft(self.driver, self.placeholder)

    def submit(self, gesture: str = 'send') -> None:
        """Only after rules 1–5 passed for this session, only with synthetic text."""
        self.run.watchdog.check()
        self.host.submit(self.driver, gesture)

    def save(self, directory: Path, label: str) -> None:
        self.driver.save(directory, label)

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            if self.driver is not None:
                self.driver.close()
        finally:
            self.run.watchdog.poll_files()
            logs = self.profile.logs
            if logs.exists() and any(logs.iterdir()):
                dest = self.run.evidence / 'host-logs' / self.profile.root.name
                shutil.copytree(logs, dest, dirs_exist_ok=True)
            profiles.remove(self.profile)
            if self in self.run.sessions:
                self.run.sessions.remove(self)


__all__ = ['Run', 'Session', 'CommandResult', 'ProviderStop', 'new_run_id', 'node_dir']


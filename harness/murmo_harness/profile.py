"""Isolated run profiles (safety rules 4 and 5).

Each session gets a new temporary folder holding HOME, every XDG folder,
every host's config folder, an npm cache, TMPDIR and a synthetic project with
its own `.git`. The environment is built from an allowlist, never copied from
the caller, and `check()` runs before every launch: every config path inside
the folder, nothing inherited that could carry a credential, the fake URL
and key everywhere a host could read a provider from. A failed check means no
launch.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import safety
from .trap import proxy_env
from .watchdog import Watchdog


class ProfileRefused(RuntimeError):
    """The pre-launch check failed; the host must not start."""


@dataclass
class Profile:
    root: Path
    fake_base_url: str
    run_id: str
    path_dirs: list[str]
    trap_url: str = ''
    env: dict[str, str] = field(default_factory=dict)

    # Layout -------------------------------------------------------------

    @property
    def home(self) -> Path:
        return self.root / 'home'

    @property
    def project(self) -> Path:
        return self.root / 'project'

    @property
    def logs(self) -> Path:
        return self.root / 'logs'

    @property
    def claude_dir(self) -> Path:
        return self.home / '.claude'

    @property
    def codex_home(self) -> Path:
        return self.home / '.codex'

    @property
    def pi_dir(self) -> Path:
        return self.home / '.pi' / 'agent'

    @property
    def opencode_config_dir(self) -> Path:
        return self.home / '.config' / 'opencode'

    @property
    def opencode_config(self) -> Path:
        # Outside the project, named explicitly: project config is disabled (lesson 53).
        return self.root / 'config' / 'opencode.json'

    @property
    def fake_v1(self) -> str:
        return f'{self.fake_base_url}/v1'

    def inside(self, path: str | Path) -> bool:
        try:
            Path(path).resolve().relative_to(self.root.resolve())
            return True
        except ValueError:
            return False


def create(root: Path, *, fake_base_url: str, run_id: str, path_dirs: list[str], trap_url: str) -> Profile:
    """Make the folder layout and the environment. Host config comes later,
    from the host profile (`HostProfile.write_config`)."""
    root.mkdir(parents=True, exist_ok=False)
    profile = Profile(root.resolve(), fake_base_url, run_id, list(path_dirs), trap_url)
    home = profile.home
    dirs = [
        home / '.config',
        home / '.local' / 'share',
        home / '.local' / 'state',
        home / '.cache',
        profile.claude_dir,
        profile.codex_home,
        profile.pi_dir,
        profile.opencode_config_dir,
        profile.opencode_config.parent,
        profile.root / 'npm-cache',
        profile.root / 'tmp',
        profile.logs,
        profile.project,
    ]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
    _init_project(profile)
    utf8 = 'en_US.UTF-8' if sys.platform == 'darwin' else 'C.UTF-8'
    env = {
        'PATH': ':'.join([*profile.path_dirs, '/usr/bin', '/bin', '/usr/sbin', '/sbin']),
        'HOME': str(home),
        'USER': os.environ.get('USER', 'murmo'),
        'LOGNAME': os.environ.get('USER', 'murmo'),
        'SHELL': '/bin/sh',
        'LANG': utf8,
        'LC_ALL': utf8,
        'TERM': 'xterm-256color',
        'TZ': 'UTC',
        'TMPDIR': str(profile.root / 'tmp'),
        'XDG_CONFIG_HOME': str(home / '.config'),
        'XDG_DATA_HOME': str(home / '.local' / 'share'),
        'XDG_STATE_HOME': str(home / '.local' / 'state'),
        'XDG_CACHE_HOME': str(home / '.cache'),
        'CLAUDE_CONFIG_DIR': str(profile.claude_dir),
        'CODEX_HOME': str(profile.codex_home),
        'PI_CODING_AGENT_DIR': str(profile.pi_dir),
        'OPENCODE_CONFIG_DIR': str(profile.opencode_config_dir),
        'OPENCODE_CONFIG': str(profile.opencode_config),
        'npm_config_cache': str(profile.root / 'npm-cache'),
        'npm_config_update_notifier': 'false',
        'NO_UPDATE_NOTIFIER': '1',
        'ANTHROPIC_BASE_URL': fake_base_url,
        'ANTHROPIC_API_KEY': safety.FAKE_KEY,
        'MURMO_FAKE_KEY': safety.FAKE_KEY,
        'MURMO_HARNESS_RUN': run_id,
        **safety.REQUIRED_FLAGS,
        # Every attempt to leave goes to the trap, which names it (trap.py).
        **proxy_env(trap_url),
    }
    profile.env = env
    return profile


def _init_project(profile: Profile) -> None:
    """A synthetic project with its own `.git`, so no host walks up into a real repository."""
    (profile.project / 'README.md').write_text('# murmo harness project\n\nSynthetic fixture project.\n')
    git_env = {
        'PATH': '/usr/bin:/bin:/usr/local/bin',
        'HOME': str(profile.home),
        'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_CONFIG_GLOBAL': os.devnull,
    }
    git = shutil.which('git', path=git_env['PATH'])
    if git is None:
        raise ProfileRefused('git is needed to give the synthetic project its own .git')
    subprocess.run([git, 'init', '-q', str(profile.project)], env=git_env, check=True, timeout=30)


def check(profile: Profile, *, host_checks: dict[str, bool], argv: list[str], cwd: Path, watchdog: Watchdog, log: Path) -> dict:
    """The pre-launch check (rule 5). Raises ProfileRefused when any check fails;
    always appends its record to `log`."""
    env = profile.env
    checks: dict[str, bool] = {}
    for var in safety.CONFIG_PATH_VARS:
        value = env.get(var)
        checks[f'inside:{var}'] = bool(value) and profile.inside(value)
    leaked = sorted(name for name in env if safety.is_scrubbed(name))
    checks['no-inherited-credentials'] = not leaked
    for name, value in safety.REQUIRED_FLAGS.items():
        checks[f'flag:{name}'] = env.get(name) == value
    checks['fake-url-loopback'] = safety.loopback_url(env.get('ANTHROPIC_BASE_URL', ''))
    checks['fake-url-is-ours'] = env.get('ANTHROPIC_BASE_URL') == profile.fake_base_url
    checks['fake-key'] = env.get('ANTHROPIC_API_KEY') == safety.FAKE_KEY and env.get('MURMO_FAKE_KEY') == safety.FAKE_KEY
    checks['cwd-is-project'] = cwd.resolve() == profile.project.resolve()
    expected_proxy = proxy_env(profile.trap_url)
    checks['proxy-is-trap'] = safety.loopback_url(profile.trap_url) and all(env.get(k) == v for k, v in expected_proxy.items())
    checks.update({f'host:{k}': v for k, v in host_checks.items()})
    # Written config and the environment are scanned like any other output.
    watchdog.scan(json.dumps(env), 'config', 'environment')
    for path in sorted(p for p in profile.root.rglob('*') if p.is_file() and p.suffix in ('.json', '.toml', '.jsonc')):
        if 'npm-cache' in path.parts or 'logs' in path.parts:
            continue
        watchdog.scan_file(path, 'config')
    checks['no-provider-in-config'] = not watchdog.stopped
    record = {
        'at': time.time(),
        'run': profile.run_id,
        'argv': argv,
        'checks': checks,
        'leaked': leaked,
        'passed': all(checks.values()),
    }
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open('a') as handle:
        handle.write(json.dumps(record) + '\n')
    if not record['passed']:
        failed = [k for k, v in checks.items() if not v]
        raise ProfileRefused(f'pre-launch check failed, not launching: {failed}')
    return record


def remove(profile: Profile) -> None:
    shutil.rmtree(profile.root, ignore_errors=True)
    if profile.root.exists():
        # Hosts sometimes leave read-only files; make them writable and retry.
        for path in profile.root.rglob('*'):
            try:
                path.chmod(0o700)
            except OSError:
                pass
        shutil.rmtree(profile.root, ignore_errors=True)

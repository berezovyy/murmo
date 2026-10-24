"""Runner, canary, evidence and cleanup: each test names the failure it catches."""

from __future__ import annotations

import dataclasses
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from support import new_run, needs_sandbox, real_install, scratch, stub_host, stub_install

from murmo_harness import evidence, paths
from murmo_harness.integrations import STOCK, Integration, IntegrationState, PluginState
from murmo_harness.inventory import RealHomeInventory
from murmo_harness.runner import Expectations, HostSubject, as_drawn, expand, load_suite

CASE = {
    'id': 'typed-line',
    'steps': [{'type': 'stub line'}, {'submit': 'send'}],
    'expect': {'requests': ['stub line']},
}


class DisabledButHealthy(Integration):
    """A session that says healthy while a plugin is disabled (lessons 71, 76)."""

    name = 'disabled-but-healthy'

    def state(self, host, profile):
        return IntegrationState(healthy=True, plugins=[PluginState('lint', False, 'faulted', 3), PluginState('correct', True)])


def subject(run, attempt, integration=None, host='stub', install=None):
    return HostSubject(
        run, host, install or stub_install(), integration=integration or STOCK, expectations=Expectations(),
        attempt=attempt, platform=paths.current_platform(),
    )


class FunctionalNotLoaded(unittest.TestCase):
    """r14 H1 with 2.0-pre: 42/42 plugins loaded while features degraded. A case
    passes only on screen and fake-server evidence, and a disabled plugin is
    reported even when the session says healthy."""

    def test_pass_needs_the_fake_server_to_see_the_text(self):
        needs_sandbox()
        with scratch() as folder, stub_host():
            with new_run(folder) as run:
                ok = subject(run, folder / 'a').run_case('t.json', CASE)
                wrong = subject(run, folder / 'b').run_case('t.json', {**CASE, 'expect': {'requests': ['other line']}})
            self.assertEqual(ok['status'], 'pass', ok)
            self.assertEqual(wrong['status'], 'fail')
            checks = json.loads((folder / 'b' / 'cases' / 'typed-line~120x40' / 'verdict.json').read_text())['checks']
            self.assertEqual(checks[0]['actual'], ['stub line'])
            self.assertEqual(checks[0]['source'], 'fake-server')

    def test_disabled_plugin_fails_although_session_healthy(self):
        needs_sandbox()
        with scratch() as folder, stub_host():
            with new_run(folder) as run:
                verdict = subject(run, folder / 'a', DisabledButHealthy()).run_case('t.json', CASE)
            record = json.loads((folder / 'a' / 'cases' / 'typed-line~120x40' / 'verdict.json').read_text())
            self.assertEqual(verdict['status'], 'fail')
            self.assertTrue(record['plugins']['healthy'])
            self.assertEqual(record['plugins']['disabled'], ['lint'])
            failed = [c for c in record['checks'] if not c['ok']]
            self.assertEqual([c['what'] for c in failed], ['plugins.noneUnexpectedlyDisabled'])

    def test_case_without_assertions_fails(self):
        """Anti-vacuity: steps with nothing to check cannot pass."""
        needs_sandbox()
        with scratch() as folder, stub_host():
            with new_run(folder) as run:
                verdict = subject(run, folder / 'a').run_case('t.json', {'id': 'empty', 'steps': [{'type': 'x'}], 'expect': {}})
            self.assertEqual(verdict['status'], 'fail')
            self.assertEqual(verdict['reason'], 'no assertions ran')

    def test_packed_skips_r14_conflict_plugins(self):
        """Packed product does not ship fixtures/plugins/conflicts.js (r14-followup)."""
        from murmo_harness.validation.integration import PackedMurmo

        needs_sandbox()
        case = {
            'id': 'order-AB-edit',
            'plugins': [{'id': 'A', 'plugin': 'conflicts', 'settings': {'letter': 'A'}}],
            'steps': [{'type': 'r14word target '}],
            'expect': {'draft': {'text': 'r14word A '}},
        }
        with scratch() as folder, stub_host():
            with new_run(folder) as run:
                packed = PackedMurmo(None, 'b')
                s = subject(run, folder / 'a', packed)
                reason = s.unsupported(case, case['expect'])
                verdict = s.run_case('hosts/r14-followup.json', case)
        self.assertEqual(reason, 'packed-no-conflict-plugins')
        self.assertEqual(verdict['status'], 'skip')
        self.assertEqual(verdict['reason'], 'packed-no-conflict-plugins')

    def test_unsupported_steps_skip_with_reason_never_pass(self):
        with scratch() as folder, stub_host():
            run = new_run(folder)
            sub = subject(run, folder / 'a')
            for case, needle in (
                ({'id': 'p', 'plugins': [{'id': 'A', 'plugin': 'conflicts'}], 'steps': [{'type': 'x'}], 'expect': {'requests': []}}, 'plugins'),
                ({'id': 'f', 'steps': [{'fill': 'x'}], 'expect': {'requests': []}}, 'fill'),
                ({'id': 'u', 'steps': [{'type': 'x'}], 'expect': {'ui': {'ghost': 'y'}}}, 'ui'),
                ({'id': 'c', 'steps': [{'type': 'x'}], 'expect': {'draft': {'text': 'x', 'cursor': 1}}}, 'cursor'),
            ):
                verdict = sub.run_case('t.json', case)
                self.assertEqual(verdict['status'], 'skip')
                self.assertIn(needle, verdict['reason'])
            self.assertEqual(run.launches, 0)

    def test_project_is_seeded_and_approved_after_setup_before_launch(self):
        """Catches a project case whose host never sees the fixture `.murmo.toml`,
        or an approval that runs before setup created the store it writes to."""
        needs_sandbox()

        class Recording(Integration):
            name = 'recording'
            features = frozenset({'host.project-config'})

            def __init__(self):
                self.calls = []

            def prepare(self, host, profile, run=None):
                self.calls.append(('prepare', (profile.project / '.murmo.toml').exists()))

            def approve_project(self, host, profile, run=None):
                self.calls.append(('approve', (profile.project / '.murmo.toml').read_text(), (profile.project / '.git').is_dir()))

        suite, cases = load_suite(paths.FIXTURES / 'hosts' / 'project-shortcuts.json')
        approved = next(c for c in cases if c['projectTrust'] == 'approved')
        recording = Recording()
        with scratch() as folder, stub_host():
            with new_run(folder) as run:
                subject(run, folder / 'a', recording).run_case(suite, {**approved, 'plugins': [], **CASE})
        text = (paths.FIXTURES / approved['project'] / '.murmo.toml').read_text()
        self.assertEqual(recording.calls, [('prepare', False), ('approve', text, True)])

    def test_restart_relaunches_in_the_same_profile_without_setup_again(self):
        """Catches a restart step that loses the home (where drafts live) or
        reinstalls Murmo, either of which would hide a lost draft."""
        needs_sandbox()

        class Recording(Integration):
            name = 'recording'
            features = frozenset({'restart'})

            def __init__(self):
                self.prepared = 0
                self.homes = []

            def prepare(self, host, profile, run=None):
                self.prepared += 1

            def argv(self, host, install, profile, argv):
                self.homes.append(profile.home)
                return argv

        recording = Recording()
        case = {
            'id': 'restarted',
            'steps': [{'type': 'lost line'}, {'restart': 'kill'}, {'type': 'stub line'}, {'submit': 'send'}],
            'expect': {'requests': ['stub line']},
        }
        with scratch() as folder, stub_host():
            with new_run(folder) as run:
                verdict = subject(run, folder / 'a', recording).run_case('t.json', case)
                launches = run.launches
        self.assertEqual(verdict['status'], 'pass', verdict)
        self.assertEqual(launches, 2)
        self.assertEqual(recording.prepared, 1)
        self.assertEqual(len(set(recording.homes)), 1)

    def test_installed_plugin_is_added_after_setup_before_launch(self):
        """Catches an installed-plugin case whose host starts before the plugin
        is added, or an add that runs before setup created the plugin store."""
        needs_sandbox()

        class Recording(Integration):
            name = 'recording'
            features = frozenset({'host.installed-plugins'})

            def __init__(self):
                self.calls = []

            def prepare(self, host, profile, run=None):
                self.calls.append('prepare')

            def install_plugin(self, host, profile, plugin, run=None):
                self.calls.append(('install', plugin['folder'].name, plugin['grants'], plugin.get('enabled', True)))

        suite, cases = load_suite(paths.FIXTURES / 'hosts' / 'installed-plugin.json')
        disabled = next(c for c in cases if c['id'] == 'disabled-plugin-stops')
        recording = Recording()
        with scratch() as folder, stub_host():
            with new_run(folder) as run:
                subject(run, folder / 'a', recording).run_case(suite, {**disabled, **CASE})
        self.assertEqual(recording.calls, ['prepare', ('install', 'send-hold', ['draft:read', 'submit'], False)])

    def test_installed_plugin_without_plugin_add_support_skips(self):
        """An integration that cannot run `murmo plugin add` must skip: the
        disabled case would otherwise pass on a host that never had the plugin."""
        with scratch() as folder, stub_host():
            run = new_run(folder)
            _, cases = load_suite(paths.FIXTURES / 'hosts' / 'installed-plugin.json')
            case = {**cases[1], 'requires': []}
            verdict = subject(run, folder / 'a').run_case('t.json', case)
            self.assertEqual(verdict['status'], 'skip')
            self.assertIn('murmo plugin add', verdict['reason'])
            self.assertEqual(run.launches, 0)

    def test_valued_integration_feature_meets_a_valued_requirement(self):
        """Catches every autocorrect case skipping on the packed product: the
        integration says `plugin.autocorrect=release` and cases require exactly
        that, but the feature was stored under the whole string."""

        class Autocorrect(Integration):
            name = 'autocorrect'
            features = frozenset({'plugins', 'plugin.autocorrect=release'})

        with scratch() as folder, stub_host():
            sub = subject(new_run(folder), folder / 'a', Autocorrect())
            case = {'id': 'a', 'steps': [{'type': 'teh '}], 'expect': {'requests': []}}
            self.assertIsNone(sub.unsupported({**case, 'requires': ['plugin.autocorrect=release']}, case['expect']))
            self.assertEqual(
                sub.unsupported({**case, 'requires': ['plugin.autocorrect=sample']}, case['expect']),
                'requires plugin.autocorrect=sample',
            )

    def test_project_approval_without_trust_support_skips(self):
        """An integration that cannot run `murmo trust` must skip, never run the
        approved case against an unreviewed file and report its result."""
        with scratch() as folder, stub_host():
            run = new_run(folder)
            case = {'id': 'p', 'project': 'hosts/projects/shortcuts', 'projectTrust': 'approved', **{k: CASE[k] for k in ('steps', 'expect')}}
            verdict = subject(run, folder / 'a').run_case('t.json', case)
            self.assertEqual(verdict['status'], 'skip')
            self.assertIn('murmo trust', verdict['reason'])
            self.assertEqual(run.launches, 0)

    def test_shared_fixture_suites_load(self):
        """The runner reads the shared fixture format; every host case maps or skips."""
        for name in ('stock-canary.json', 'r14-followup.json', 'project-shortcuts.json', 'installed-plugin.json'):
            suite, cases = load_suite(paths.FIXTURES / 'hosts' / name)
            self.assertTrue(cases)
            self.assertEqual(suite, f'hosts/{name}')
        self.assertEqual(expand(['a', {'repeat': 'b', 'times': 3}]), 'abbb')

    def test_screen_drafts_compare_as_drawn(self):
        """Catches `;hp ` failing against a screen that shows `;hp`: a trailing
        space never draws, so the expectation is compared as the screen shows it,
        while a different word still fails."""
        self.assertEqual(as_drawn('harness project shortcut '), 'harness project shortcut')
        self.assertEqual(as_drawn('alpha  \nbeta \n\n'), 'alpha\nbeta')
        self.assertEqual(as_drawn('  lead'), '  lead')
        self.assertNotEqual(as_drawn(';hp '), 'harness project shortcut')

    def test_expectation_files_change_cases_without_harness_changes(self):
        """Adapter phases add per-host expectation files; nothing else changes."""
        with scratch() as folder:
            target = folder / 'stock'
            target.mkdir()
            (target / 'stub.json').write_text(json.dumps({
                'kind': 'host-expectations/v1', 'host': 'stub',
                'suites': {'t.json': {'typed-line': {'skip': 'stub cannot do this (test)'}}},
            }))
            exp = Expectations.load('stock', 'stub', folder)
            run = new_run(folder)
            with stub_host():
                sub = HostSubject(run, 'stub', stub_install(), integration=STOCK, expectations=exp,
                                  attempt=folder / 'a', platform=paths.current_platform())
                verdict = sub.run_case('t.json', CASE)
            self.assertEqual((verdict['status'], verdict['declared']), ('skip', True))


class FormatCanary(unittest.TestCase):
    """knowledge § 9: a compatibility test silently stopped testing anything.
    Each run reports its canary; a run against a mismatched version fails."""

    def test_mismatched_version_fails_canary(self):
        needs_sandbox()
        from murmo_harness.probe import probe

        real = real_install('pi')
        wrong = dataclasses.replace(real, version='1.2.0' if real.version != '1.2.0' else '1.3.0')
        with scratch() as folder, new_run(folder) as run:
            good = probe(run, 'pi', real)
            bad = probe(run, 'pi', wrong, submit=False)
        self.assertTrue(good['passed'], good['canary'])
        self.assertTrue(good['canary']['checks']['fake-got-exact-line'])
        self.assertFalse(bad['passed'])
        self.assertFalse(bad['canary']['checks']['version-matches'])


class Retention(unittest.TestCase):
    """AGENTS.md: at most 3 attempts per measurement; no stray target/ folder."""

    def test_keeps_last_three(self):
        with scratch() as folder:
            made = [evidence.new_attempt('suite', 'pi-1.3.0-darwin-arm64', base=folder, now=1_800_000_000 + i) for i in range(5)]
            left = sorted(p.name for p in (folder / 'suite' / 'pi-1.3.0-darwin-arm64').iterdir())
            self.assertEqual(left, [p.name for p in made[-3:]])

    def test_no_target_folder_in_checkout(self):
        self.assertEqual(evidence.stray_targets(paths.REPO), [])

    def test_only_cargo_build_folders_count_as_stray(self):
        """A source module or shipped files named `target` are not a build cache."""
        with scratch() as folder:
            (folder / 'vendor' / 'cc' / 'src' / 'target').mkdir(parents=True)
            (folder / 'installed' / 'target' / 'release').mkdir(parents=True)
            build = folder / 'crate' / 'target'
            build.mkdir(parents=True)
            (build / 'CACHEDIR.TAG').write_text('Signature: 8a477f597d28d172789f06886806bc55\n')
            self.assertEqual(evidence.stray_targets(folder), ['crate/target'])


class RealHomeInventoryIsMetadataOnly(unittest.TestCase):
    """Rule 11: the real-HOME check never opens a file and never stores a name."""

    def test_names_hashed_contents_unread(self):
        with scratch() as folder:
            (folder / '.codex').mkdir()
            secret = folder / '.codex' / 'private-name.txt'
            secret.write_text('contents nobody may read')
            secret.chmod(0)  # unreadable: an open() would fail, lstat() does not
            inventory = RealHomeInventory(folder)
            before = inventory.snapshot()
            dumped = json.dumps(before)
            self.assertNotIn('private-name', dumped)
            self.assertEqual(len(before), 2)
            (folder / '.codex' / 'new').write_text('x')
            result = RealHomeInventory.compare(before, inventory.snapshot())
            self.assertEqual(result['counts']['added'], 1)
            # The new file, and its folder's mtime.
            self.assertEqual(result['byRoot'], {'.codex': {'added': 1, 'removed': 0, 'changed': 1}})
            secret.chmod(0o600)

    def test_sandbox_denies_host_access_to_real_agent_folders(self):
        """Lesson 53 / r10: hosts read the real Claude profile and real-home
        skills. On macOS the sandbox denies even a stat of those folders."""
        if sys.platform != 'darwin':
            self.skipTest('Linux containers never mount the real HOME')
        probe = 'import os,sys\nfor p in sys.argv[1:]:\n  try:\n    os.stat(p); print("open", p)\n  except PermissionError:\n    print("denied")\n  except FileNotFoundError:\n    print("absent")\n'
        targets = [str(Path.home() / d) for d in ('.claude', '.codex', '.agents', '.config/opencode', '.npm')]
        with scratch() as folder, new_run(folder) as run:
            argv = run.sandbox.wrap([sys.executable, '-I', '-c', probe, *targets])
            done = subprocess.run(argv, capture_output=True, text=True, timeout=30, env={'PATH': '/usr/bin:/bin'})
        results = done.stdout.split()
        self.assertNotIn('open', results)
        self.assertEqual(len([r for r in results if r in ('denied', 'absent')]), len(targets))


class PtyScreen(unittest.TestCase):
    def test_modify_other_keys_query_does_not_kill_the_reader(self):
        # Round 4 (r4e7c): Claude's Ctrl+G opened vim, vim sent `CSI ? 4 m`, pyte
        # raised a TypeError in the reader thread and the run died without cleanup.
        from murmo_harness.deps import ensure_pyte
        from murmo_harness.drivers.pty import make_screen

        pyte = ensure_pyte()
        replies: list[str] = []
        screen = make_screen(pyte, 20, 2, replies.append)
        stream = pyte.Stream(screen)
        stream.feed('\x1b[?4m\x1b[1mok')
        self.assertEqual(screen.display[0].rstrip(), 'ok')
        self.assertTrue(screen.buffer[0][0].bold)


class CleanExit(unittest.TestCase):
    """Rule 11: consecutive runs leave no host, helper, tmux server or temp home."""

    RUNS = int(os.environ.get('MURMO_HARNESS_CLEAN_RUNS', '100'))

    def test_reused_terminal_is_not_ours(self):
        """Found here: one run claimed (and would have killed) another run's
        host that the OS had given the same, since-released tty. Rule 10:
        never signal anything that is not ours."""
        import time as clock

        from murmo_harness.procs import Proc, ProcessRegistry

        registry = ProcessRegistry()
        registry.ttys['ttys099'] = clock.time() - 1
        then = clock.strftime('%a %b %d %H:%M:%S %Y', clock.localtime(clock.time() - 3600))
        now = clock.strftime('%a %b %d %H:%M:%S %Y', clock.localtime())
        table = {
            10: Proc(10, 1, 10, 'S', 'ttys099', then, 'someone else'),
            11: Proc(11, 1, 11, 'S', 'ttys099', now, 'ours'),
        }
        self.assertEqual(sorted(registry._owned(table)), [11])

    def test_consecutive_runs_leave_nothing(self):
        needs_sandbox()
        import shutil

        drivers = ['pty', 'tmux'] if shutil.which('tmux') else ['pty']
        with scratch() as folder, stub_host('--child'):
            ids = []
            for i in range(self.RUNS):
                run = new_run(folder / f'r{i}', read_denials=False)
                ids.append(run.id)
                with run:
                    session = run.open_session('stub', stub_install(), driver=drivers[i % len(drivers)])
                    session.type('x')
                self.assertTrue(run.cleanup['clean'], (i, run.cleanup))
                shutil.rmtree(folder / f'r{i}', ignore_errors=True)
        # Afterwards, nothing that carries any of these runs' ids exists
        # (other harness runs on the machine may be busy; they are not ours).
        from murmo_harness.procs import snapshot

        left = [p.command for p in snapshot().values() if any(i in p.command for i in ids)]
        temps = [p for p in paths.temp_root().iterdir() if any(p.name.startswith(i) for i in ids)]
        sockets_dir = Path(f'/tmp/tmux-{os.getuid()}')
        sockets = [p for p in sockets_dir.iterdir() if any(p.name.startswith(i) for i in ids)] if sockets_dir.exists() else []
        self.assertEqual((left, temps, sockets), ([], [], []))


if __name__ == '__main__':
    unittest.main()

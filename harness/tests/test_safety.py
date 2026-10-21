"""The safety rules, each proved by a failure it must catch (docs/plan/20,
Tests and acceptance). Stub-host tests run anywhere the sandbox does; tests
on real hosts skip with the install command when the host is not cached."""

from __future__ import annotations

import json
import sys
import time
import unittest
import urllib.error
import urllib.request

from support import new_run, needs_sandbox, real_install, scratch, stub_host, stub_install

from murmo_harness import safety
from murmo_harness.fake_model import FakeModelServer
from murmo_harness.hosts import HOSTS
from murmo_harness.procs import snapshot
from murmo_harness.profile import ProfileRefused
from murmo_harness.sandbox import MacSandbox, SandboxBroken
from murmo_harness.session import Run
from murmo_harness.watchdog import ProviderStop, Watchdog, ensure_not_stopped

PROVIDER = 'api.' + 'openai.com'  # spelled apart so this file is not itself a hit


def owned(run: Run) -> list:
    return run.registry.alive()


class FailsClosed(unittest.TestCase):
    """Lesson 44: a fake-provider config alone let Codex reach api.openai.com.
    A sandbox profile that lets the network through must stop the run before
    any host starts."""

    def test_open_network_profile_fails_self_test_and_starts_nothing(self):
        if sys.platform != 'darwin':
            self.skipTest('the macOS profile check; Linux refuses outside the container (next test)')
        broken = '(version 1)\n(allow default)\n'
        with scratch() as folder:
            run = new_run(folder, sandbox_factory=lambda run_id, root: MacSandbox(run_id, root, profile_text=broken))
            with stub_host():
                with self.assertRaises(SandboxBroken):
                    run.open()
                with self.assertRaises(SandboxBroken):
                    run.open_session('stub', stub_install())
                run.close()
            self.assertEqual(run.launches, 0)
            self.assertFalse(json.loads((folder / 'evidence' / 'self-test.json').read_text())['passed'])
            self.assertTrue(run.cleanup['clean'])

    def test_linux_outside_container_refuses(self):
        from murmo_harness.sandbox import ContainerSandbox, in_no_network_container

        if in_no_network_container():
            self.skipTest('inside the container the sandbox is real')
        with self.assertRaises(SandboxBroken):
            ContainerSandbox()

    def test_tampered_profile_refuses_launch(self):
        """The rendered profile is re-read at every launch; an edit after the
        self-test (say, to allow the network) refuses the launch."""
        needs_sandbox()
        if sys.platform != 'darwin':
            self.skipTest('macOS profile file')
        with scratch() as folder, stub_host():
            with new_run(folder) as run:
                run.sandbox.profile_path.write_text('(version 1)\n(allow default)\n')
                with self.assertRaises(SandboxBroken):
                    run.open_session('stub', stub_install())
                self.assertEqual(run.launches, 0)  # refused before anything ran
                self.assertEqual(owned(run), [])


class WatchdogStops(unittest.TestCase):
    """Round 11's `ENOTFOUND api.anthropic.com`: a provider hostname anywhere in
    a session stops the whole run within 1 s with no host process left."""

    def _leak(self, flag: str):
        needs_sandbox()
        with scratch() as folder, stub_host(flag, PROVIDER, '--child', '--delay', '0.8'):
            run = new_run(folder)
            with run:
                session = run.open_session('stub', stub_install())
                root = session.driver.root_pid()
                leak_file = session.profile.logs / 'stub-debug.log.leak-at'
                deadline = time.monotonic() + 10
                while run.watchdog.stop_seconds is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(run.watchdog.stopped, 'the leak was not seen')
                # From the moment the stub showed the hostname to the last process killed.
                total = run.watchdog.hit.at + run.watchdog.stop_seconds - float(leak_file.read_text())
                self.assertLess(total, 1.0)
                self.assertEqual(owned(run), [], 'host processes survived the stop')
                left = snapshot().get(root)
                self.assertTrue(left is None or left.stat.startswith('Z'), 'the host root process is still running')
                with self.assertRaises(ProviderStop):
                    run.watchdog.check()
            evidence = folder / 'evidence' / 'STOPPED-PROVIDER.json'
            self.assertEqual(json.loads(evidence.read_text())['hostname'], PROVIDER)
            # No later run starts until a person removes the marker.
            with self.assertRaises(ProviderStop):
                ensure_not_stopped(folder / 'STOPPED-PROVIDER.json')
            self.assertTrue(run.cleanup['clean'])
            return json.loads(evidence.read_text())

    def test_frame(self):
        self.assertEqual(self._leak('--leak-screen')['source'], 'screen')

    def test_status_line(self):
        self.assertIn(self._leak('--leak-title')['source'], ('status', 'screen'))

    def test_host_log(self):
        self.assertEqual(self._leak('--leak-log')['source'], 'host-log')

    def test_network_attempt_through_trap(self):
        """macOS redacts denied addresses; the trap names the target instead."""
        record = self._leak_fetch()
        self.assertEqual(record['source'], 'network')

    def _leak_fetch(self):
        needs_sandbox()
        with scratch() as folder, stub_host('--fetch', f'https://{PROVIDER}/v1/models'):
            run = new_run(folder)
            with run:
                # The stub's request reaches the trap during startup; the stop
                # surfaces as ProviderStop (or a refused start once killed).
                with self.assertRaises(Exception):
                    session = run.open_session('stub', stub_install())
                    session.driver.drain(1.0)
                    run.watchdog.check()
                self.assertTrue(run.watchdog.stopped)
                self.assertEqual(owned(run), [])
            return json.loads((folder / 'evidence' / 'STOPPED-PROVIDER.json').read_text())

    def test_split_across_reads_and_whitespace(self):
        """Hostnames wrapped across rows or split between reads still count."""
        with scratch() as folder:
            killed = []
            dog = Watchdog('t', folder, lambda: killed.append(1), stop_marker=folder / 'm.json')
            dog.scan('connecting to api.ope', 'screen', 'x', stream=True)
            self.assertFalse(dog.stopped)
            dog.scan('\x1b[31mnai.co\r\n m/v1', 'screen', 'x', stream=True)
            self.assertTrue(dog.stopped)
            self.assertEqual(killed, [1])

    def test_help_exception_only_in_no_network_container(self):
        """The user-approved exception covers help and documentation text in a
        --network none container, and nothing else."""
        with scratch() as folder:
            inside = Watchdog('t', folder, lambda: None, in_no_network_container=True, stop_marker=folder / 'a.json')
            inside.scan(f'see https://{PROVIDER}/docs', 'help', 'pi --help')
            self.assertFalse(inside.stopped)
            self.assertEqual(len(inside.help_mentions), 1)
            inside.scan(f'Error: ENOTFOUND {PROVIDER}', 'stderr', 'session')
            self.assertTrue(inside.stopped)
            outside = Watchdog('t', folder, lambda: None, in_no_network_container=False, stop_marker=folder / 'b.json')
            outside.scan(f'see https://{PROVIDER}/docs', 'help', 'pi --help')
            self.assertTrue(outside.stopped)

    def test_real_pi_docs_in_container_do_not_stop(self):
        """Pi ships docs naming provider hosts; read as documentation inside the
        no-network container they are recorded, not a stop."""
        from support import in_container

        if not in_container():
            self.skipTest('the exception exists only inside the --network none container')
        install = real_install('pi')
        docs = sorted(install.dir.rglob('*.md'))
        with scratch() as folder:
            with new_run(folder) as run:
                prof = run.new_profile(HOSTS['pi'], install, 'help')
                result = run.host_command(HOSTS['pi'], prof, HOSTS['pi'].help_argv(install, prof), source='help')
                self.assertEqual(result.code, 0)
                for doc in docs:
                    run.watchdog.scan(doc.read_text(errors='replace'), 'help', doc.name)
                self.assertFalse(run.watchdog.stopped)
                self.assertGreater(len(run.watchdog.help_mentions), 0, 'pi docs no longer name a provider host')


class FakeKeyOnly(unittest.TestCase):
    """Rule 1: any other key gets 403, and no request header reaches any log."""

    def test_wrong_key_403_and_headers_never_logged(self):
        with scratch() as folder:
            log = folder / 'fake.jsonl'
            fake = FakeModelServer(log).start()
            try:
                body = json.dumps({'model': 'm', 'messages': [{'role': 'user', 'content': 'hi'}]}).encode()
                secret = 'header-canary-7f3a'

                def post(key):
                    request = urllib.request.Request(
                        fake.base_url + '/v1/chat/completions', data=body,
                        headers={'Authorization': f'Bearer {key}', 'X-Canary': secret, 'Content-Type': 'application/json'},
                    )
                    try:
                        return urllib.request.urlopen(request, timeout=5).status
                    except urllib.error.HTTPError as error:
                        return error.code

                self.assertEqual(post('sk-real-looking-key'), 403)
                self.assertEqual(post(safety.FAKE_KEY), 200)
            finally:
                fake.close()
            text = log.read_text()
            self.assertNotIn(secret, text)
            self.assertNotIn('Bearer', text)
            self.assertNotIn(safety.FAKE_KEY, text)
            statuses = [json.loads(line)['status'] for line in text.splitlines()]
            self.assertEqual(statuses, [403, 200])

    def test_unknown_route_404_and_flagged(self):
        with scratch() as folder:
            fake = FakeModelServer(folder / 'f.jsonl').start()
            try:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(fake.base_url + '/v1/other', data=b'{}', timeout=5)
                self.assertEqual(caught.exception.code, 404)
                self.assertEqual(fake.flagged()[0]['flag'], 'unknown-route')
            finally:
                fake.close()


class ProfileChecks(unittest.TestCase):
    """Rules 4 and 5: the pre-launch check refuses a profile that could reach a
    real provider, and Claude's seeding survives `claude plugin install`."""

    def test_inherited_credential_refuses_launch(self):
        needs_sandbox()
        with scratch() as folder, stub_host():
            with new_run(folder) as run:
                host = HOSTS['stub']
                prof = run.new_profile(host, stub_install(), 'leak')
                prof.env['OPENAI_API_KEY'] = 'sk-not-real'
                with self.assertRaises(ProfileRefused):
                    run.preflight(host, prof, host.launch_argv(stub_install(), prof))
                self.assertEqual(run.launches, 0)

    def test_config_path_outside_run_refuses_launch(self):
        needs_sandbox()
        with scratch() as folder, stub_host():
            with new_run(folder) as run:
                host = HOSTS['stub']
                prof = run.new_profile(host, stub_install(), 'outside')
                prof.env['CODEX_HOME'] = '/tmp'
                with self.assertRaises(ProfileRefused):
                    run.preflight(host, prof, [])

    def test_codex_without_rule4_flags_refuses(self):
        """Lesson 53: the provider in config.toml alone is not enough."""
        needs_sandbox()
        install = real_install('codex')
        with scratch() as folder, new_run(folder) as run:
            host = HOSTS['codex']
            prof = run.new_profile(host, install, 'flags')
            with self.assertRaises(ProfileRefused):
                run.preflight(host, prof, [*install.argv(), '--no-alt-screen'])
            record = run.preflight(host, prof, host.launch_argv(install, prof))
            self.assertTrue(record['checks']['host:argv-model-provider'])

    def test_claude_seed_survives_plugin_install_rewrite(self):
        """Round 11 (E4): `claude plugin install` wrote `.claude.json` before
        seeding; the check merges again and then verifies."""
        needs_sandbox()
        install = real_install('claude')
        with scratch() as folder, new_run(folder) as run:
            host = HOSTS['claude']
            prof = run.new_profile(host, install, 'seed')
            argv = host.launch_argv(install, prof)
            for path in host.state_files(prof):
                path.write_text(json.dumps({'numStartups': 1, 'installMethod': 'plugin'}))
            record = run.preflight(host, prof, argv)
            self.assertTrue(record['passed'])
            data = json.loads(host.state_files(prof)[0].read_text())
            self.assertEqual(data['numStartups'], 1, 'the merge must keep what the install wrote')
            # A settings file pointed elsewhere is never "fixed"; it refuses.
            settings = json.loads(host.settings_path(prof).read_text())
            settings['env']['ANTHROPIC_BASE_URL'] = 'http://10.0.0.1:9'
            host.settings_path(prof).write_text(json.dumps(settings))
            with self.assertRaises(ProfileRefused):
                run.preflight(host, prof, argv)

    def test_real_claude_plugin_install_then_check(self):
        """The real `claude plugin install` from a synthetic local marketplace,
        then the pre-launch check: the fake URL, key, onboarding and trust are
        still there, or the launch is refused."""
        needs_sandbox()
        install = real_install('claude')
        with scratch() as folder, new_run(folder) as run:
            host = HOSTS['claude']
            prof = run.new_profile(host, install, 'plugin')
            market = prof.root / 'market'
            plugin = market / 'canary-plugin'
            (market / '.claude-plugin').mkdir(parents=True)
            (plugin / '.claude-plugin').mkdir(parents=True)
            (plugin / 'commands').mkdir()
            (plugin / 'commands' / 'canary.md').write_text('Say the synthetic canary word.\n')
            (plugin / '.claude-plugin' / 'plugin.json').write_text(json.dumps({'name': 'canary-plugin', 'version': '0.0.1', 'description': 'harness canary'}))
            (market / '.claude-plugin' / 'marketplace.json').write_text(json.dumps({
                'name': 'murmo-harness-market', 'owner': {'name': 'murmo'},
                'plugins': [{'name': 'canary-plugin', 'source': './canary-plugin', 'description': 'harness canary'}],
            }))
            settings = ['--settings', str(host.settings_path(prof))]
            added = run.host_command(host, prof, [*install.argv(), *settings, 'plugin', 'marketplace', 'add', str(market)], timeout=90)
            self.assertEqual(added.code, 0, added.stderr[-800:] + added.stdout[-800:])
            done = run.host_command(host, prof, [*install.argv(), *settings, 'plugin', 'install', 'canary-plugin@murmo-harness-market'], timeout=90)
            self.assertEqual(done.code, 0, done.stderr[-800:] + done.stdout[-800:])
            record = run.preflight(host, prof, host.launch_argv(install, prof))
            self.assertTrue(record['passed'])
            for path in host.state_files(prof):
                data = json.loads(path.read_text())
                self.assertTrue(data['hasCompletedOnboarding'])
                self.assertTrue(data['projects'][str(prof.project)]['hasTrustDialogAccepted'])
            self.assertFalse(run.watchdog.stopped)


class ThirdPartyOnlyInContainer(unittest.TestCase):
    """Rule 7 (E11): third-party code never runs on the macOS host, even sandboxed."""

    def test_third_party_integration_refused_outside_container(self):
        from murmo_harness.integrations import Integration
        from support import in_container

        needs_sandbox()
        if in_container():
            self.skipTest('allowed inside the --network none container')

        class Peer(Integration):
            name = 'peer-plugins'
            third_party = True

        with scratch() as folder, stub_host():
            run = new_run(folder)
            run.open()
            try:
                with self.assertRaises(SandboxBroken):
                    run.open_session('stub', stub_install(), integration=Peer())
                self.assertEqual(run.launches, 0)
            finally:
                run.close()


if __name__ == '__main__':
    unittest.main()

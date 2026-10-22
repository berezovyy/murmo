"""Phase 29: skip ≠ pass, oracles catch the r14 failures, the report is honest."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from support import scratch

from murmo_harness.validation.connect import audit_connects, classify_target
from murmo_harness.validation.matrix import PLUGIN_SETS, expand_matrix, freeze_versions
from murmo_harness.validation.oracles import evaluate
from murmo_harness.validation.report import write_report
from murmo_harness.validation.scenarios import catalog
from murmo_harness.validation.skips import SKIP_REASONS, Skip, World, decide_skip


def world(**kw) -> World:
    base = dict(platform='darwin-arm64', in_container=False, sandbox_ok=True, packed=None,
                hosts={}, helper=False, wrapper=False, tmux=True, strace=False, conformance=False)
    base.update(kw)
    return World(**base)


def rows_for(scenario_id: str, versions=None):
    versions = versions or {
        'pi': {'latest': '1.3.0', 'previous': '1.2.0', 'older': ()},
        'opencode': {'latest': '2.1.1', 'previous': '2.1.0', 'older': ('2.0.32',)},
        'claude': {'latest': '2.1.304', 'previous': '2.1.303', 'older': ('2.1.302',)},
        'codex': {'latest': '0.163.0', 'previous': '0.162.1', 'older': ()},
    }
    scenario = next(s for s in catalog() if s.id == scenario_id)
    return expand_matrix(scenario, versions)


class NamedSkips(unittest.TestCase):
    """A missing host or tarball skips with a frozen token and never passes."""

    def test_skip_reason_set_is_frozen(self):
        # A silent rename would hide a skip from greps.
        self.assertEqual(set(SKIP_REASONS), {
            'host-binary-missing', 'older-host-binary-missing', 'packed-product-missing',
            'signing-key-missing', 'helper-binary-missing', 'codex-wrapper-missing',
            'sandbox-unavailable', 'cpu-quota-unavailable', 'linux-container-required',
            'tmux-missing', 'strace-unavailable', 'peer-fixture-missing', 'x64-untested',
            'quiet-machine-unconfirmed', 'conformance-results-missing',
        })

    def test_unknown_skip_token_is_refused(self):
        with self.assertRaises(ValueError):
            Skip('not-a-real-reason')

    def test_missing_host_skips_and_does_not_pass(self):
        row = rows_for('correction-bursts')[0]
        skip = decide_skip(row, world(packed=object(), helper=True))
        self.assertIsNotNone(skip)
        self.assertEqual(skip.reason, 'host-binary-missing')
        self.assertNotEqual(skip.reason, 'pass')

    def test_previous_minor_uses_older_token(self):
        row = next(r for r in rows_for('correction-bursts') if r.channel == 'previous')
        skip = decide_skip(row, world(packed=object(), helper=True))
        self.assertEqual(skip.reason, 'older-host-binary-missing')

    def test_missing_packed_product_skips_before_host_check(self):
        row = rows_for('functional-contract')[0]
        skip = decide_skip(row, world(hosts={('pi', '1.3.0'): object()}))
        self.assertEqual(skip.reason, 'packed-product-missing')

    def test_slow_cpu_on_macos_skips_quota(self):
        row = next(r for r in rows_for('slow-cpu-1') if r.os == 'darwin')
        skip = decide_skip(row, world(packed=object(), helper=True, hosts={(row.host, row.version): object()}))
        self.assertEqual(skip.reason, 'cpu-quota-unavailable')

    def test_peers_refuse_macos(self):
        row = next(r for r in rows_for('coexistence-peers') if r.os == 'darwin')
        skip = decide_skip(row, world(packed=object(), helper=True, hosts={(row.host, row.version): object()}, peers=True))
        self.assertEqual(skip.reason, 'linux-container-required')

    def test_x64_without_binaries_skips(self):
        row = rows_for('functional-contract')[0]
        skip = decide_skip(row, world(platform='linux-x64', packed=object(), helper=False, wrapper=False,
                                      hosts={(row.host, row.version): object()}))
        self.assertEqual(skip.reason, 'x64-untested')

    def test_present_host_and_product_do_not_skip_functional(self):
        row = next(r for r in rows_for('functional-contract') if r.host == 'pi' and r.channel == 'latest' and r.os == 'darwin')
        skip = decide_skip(row, world(packed=object(), helper=True, hosts={('pi', '1.3.0'): object()}))
        self.assertIsNone(skip)


class OraclesCatchR14(unittest.TestCase):
    """Each oracle names the r14 failure it would have caught."""

    def test_correction_fails_10_of_30_linux_codex(self):
        # E3: Linux Codex 20 plugins 10/30.
        result = evaluate('correction-bursts', {'host': 'codex', 'hits': 10, 'trials': 180})
        self.assertEqual(result.status, 'fail')
        self.assertIn('burst-hits', result.reason)

    def test_paste_corrected_always_fails(self):
        result = evaluate('correction-bursts', {'host': 'pi', 'hits': 30, 'trials': 30, 'pastedCorrected': True})
        self.assertEqual(result.status, 'fail')

    def test_claude_burst_edit_fails(self):
        result = evaluate('correction-bursts', {'host': 'claude', 'keyedHits': 5, 'keyedTrials': 5, 'burstEdits': 1})
        self.assertEqual(result.status, 'fail')

    def test_host_labeled_advertised_without_proof_fails(self):
        result = evaluate('claims-match-host', {
            'host': 'pi',
            'advertised': {'inputOriginEvidence': 'host-labeled'},
            'observed': {'hostLabeledProven': False},
        })
        self.assertEqual(result.status, 'fail')
        self.assertIn('host-labeled', result.reason)

    def test_opencode_dialogSafe_true_fails(self):
        result = evaluate('claims-match-host', {
            'host': 'opencode',
            'advertised': {'inputOriginEvidence': 'host-labeled', 'ui.dialogSafe': True},
            'observed': {'hostLabeledProven': True, 'statusPlacement': 'prompt.footer', 'statusOverDialog': False},
        })
        self.assertEqual(result.status, 'fail')

    def test_menu_enter_send_fails(self):
        result = evaluate('all-at-once', {
            'host': 'pi', 'menuEnterSends': 1, 'menuEnterCases': 8,
            'nativeUiWins': True, 'orderFollowsList': True, 'perKeyP50Ms': 1, 'controlP50Ms': 1,
        })
        self.assertEqual(result.status, 'fail')

    def test_slow_cpu_p95_over_16ms_fails(self):
        # r14 Codex 10 plugins: 155.96 vs 50.60.
        result = evaluate('slow-cpu-1', {
            'cpus': 1, 'testP95Ms': 155.96, 'controlP95Ms': 50.60, 'hits': 30, 'disabled': [],
        })
        self.assertEqual(result.status, 'fail')
        self.assertIn('p95-over-control', result.reason)

    def test_one_timeout_disable_fails(self):
        result = evaluate('false-timeout', {'disabledAfterOneTimeout': ['menu'], 'disabled': ['menu'], 'strikesToDisable': 1})
        self.assertEqual(result.status, 'fail')

    def test_flood_268_edits_in_2s_fails(self):
        result = evaluate('edit-flood', {'applied': 268, 'seconds': 2, 'stillEnabled': True})
        self.assertEqual(result.status, 'fail')

    def test_killed_helper_still_healthy_fails(self):
        result = evaluate('killed-supervisor', {
            'status': 'healthy', 'doctor': {'helperDown': False}, 'correctionWorks': True,
            'hostAlive': True, 'sessionHealthy': True,
        })
        self.assertEqual(result.status, 'fail')

    def test_unexpected_connect_fails(self):
        result = evaluate('outbound-connect', {'murmoUnexpected': [{'target': 'https://example.com/telemetry'}]})
        self.assertEqual(result.status, 'fail')

    def test_empty_evidence_fails_closed(self):
        for sid in ('functional-contract', 'security-s1-s6', 'false-timeout', 'all-at-once', 'outbound-connect'):
            result = evaluate(sid, {})
            self.assertEqual(result.status, 'fail', sid)
            self.assertEqual(result.reason, 'no assertions ran')

    def test_pi_30_of_30_passes(self):
        result = evaluate('correction-bursts', {'host': 'pi', 'hits': 30, 'trials': 30, 'pastedCorrected': False})
        self.assertEqual(result.status, 'pass')

    def test_documented_opencode_paste_order_is_limitation(self):
        result = evaluate('correction-bursts', {
            'host': 'opencode', 'hits': 0, 'trials': 30, 'opencodePasteOrder': True, 'pastedCorrected': False,
        })
        self.assertEqual(result.status, 'limitation')

    def test_shared_machine_tails_are_unconfirmed_not_pass(self):
        result = evaluate('slow-cpu-1', {
            'cpus': 1, 'testP95Ms': 20, 'controlP95Ms': 18, 'hits': 30, 'disabled': [],
            'sharedMachineTails': True,
        })
        self.assertEqual(result.status, 'unconfirmed')
        self.assertNotEqual(result.status, 'pass')


class ConnectAudit(unittest.TestCase):
    """E18: only the fake model and unix sockets are allowed."""

    def test_fake_and_unix_allowed_telemetry_not(self):
        self.assertEqual(classify_target('http://127.0.0.1:9/v1', fake_port=9, trap_port=8), 'allowed')
        self.assertEqual(classify_target('unix:/tmp/murmo.sock', fake_port=9, trap_port=8), 'allowed')
        self.assertEqual(classify_target('https://api.example.com/v1', fake_port=9, trap_port=8), 'unexpected')

    def test_murmo_process_telemetry_is_a_finding(self):
        report = audit_connects(
            [{'target': 'https://example.com/update', 'command': 'murmo-plugin-host --worker', 'source': 'strace'}],
            fake_port=9, trap_port=8,
        )
        self.assertFalse(report['passed'])
        self.assertEqual(len(report['murmoUnexpected']), 1)


class ReportHonesty(unittest.TestCase):
    """The markdown never writes PASS for a skip (docs/plan/29)."""

    def test_skip_is_not_pass_in_markdown(self):
        with scratch() as folder:
            dest = folder / 'v1-platform-validation.md'
            write_report({
                'generatedAt': '2026-10-22T00:00:00Z',
                'platform': 'darwin-arm64',
                'package': None,
                'rows': [
                    {'id': 'correction-bursts/pi@1.3.0/darwin/b', 'section': 'correction',
                     'host': 'pi', 'version': '1.3.0', 'os': 'darwin', 'pluginSet': 'b',
                     'status': 'skip', 'reason': 'host-binary-missing',
                     'skip': {'reason': 'host-binary-missing', 'message': SKIP_REASONS['host-binary-missing']}},
                    {'id': 'correction-bursts/codex@0.163.0/linux/b', 'section': 'correction',
                     'host': 'codex', 'version': '0.163.0', 'os': 'linux', 'pluginSet': 'b',
                     'status': 'fail', 'reason': 'burst-hits', 'owner': '23'},
                ],
            }, dest=dest)
            text = dest.read_text()
            self.assertIn('skip `host-binary-missing`', text)
            self.assertNotIn('| pi | 1.3.0 | darwin | b | PASS |', text)
            self.assertIn('FAIL burst-hits', text)
            self.assertIn('Release blockers', text)
            self.assertIn('`correction-bursts/codex@0.163.0/linux/b`', text)
            self.assertIn('ran 1', text)
            self.assertNotIn('No live-host row ran', text)
            self.assertIn('host-binary-missing', text)

    def test_plugin_sets_a_through_e_exist(self):
        self.assertEqual(set(PLUGIN_SETS), {'a', 'b', 'c', 'd', 'e'})
        self.assertFalse(PLUGIN_SETS['a']['autocorrect'])
        self.assertTrue(PLUGIN_SETS['b']['autocorrect'])
        self.assertIn('status-counter', PLUGIN_SETS['c']['plugins'])
        self.assertTrue(PLUGIN_SETS['d']['testBuild'])
        self.assertEqual(PLUGIN_SETS['e']['counts'], (0, 1, 5, 10, 20))

    def test_older_probe_is_its_own_row(self):
        older = [r for r in rows_for('older-probe') if r.host == 'opencode']
        self.assertTrue(any(r.version == '2.0.32' and r.channel == 'older-probe' for r in older))

    def test_catalog_covers_every_section(self):
        from murmo_harness.validation.scenarios import SECTIONS
        got = {s.section for s in catalog()}
        self.assertEqual(got, set(SECTIONS))

    def test_control_flag_on_load_and_startup(self):
        ids = {s.id for s in catalog() if s.control}
        self.assertEqual(ids, {'slow-cpu-1', 'slow-cpu-half', 'startup-pairs'})


class PlanDoesNotLaunch(unittest.TestCase):
    """`--plan` expands the matrix and skips/plans; it must not open a host."""

    def test_validate_plan_never_passes_a_skip(self):
        from murmo_harness.validation.runner import validate
        summary = validate(execute=False, smoke=True)
        self.assertGreater(summary['counts']['total'], 0)
        self.assertEqual(summary['counts']['pass'], 0)
        self.assertEqual(summary['counts']['fail'], 0)
        for row in summary['rows']:
            self.assertIn(row['status'], ('skip', 'planned'))
            self.assertNotEqual(row['status'], 'pass')

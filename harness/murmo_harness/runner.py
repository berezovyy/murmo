"""Fixture-to-case runner: the `host:<name>` subject of docs/plan/02.

Each shared fixture case (`editor-ops/v1`) becomes driver steps on a fresh
session of a real host. A case passes only on what the screen shows and what
the fake server received, never on "the session loaded" (r14 H1 with
2.0-pre: 42/42 plugins loaded while features degraded). Per-plugin state is
read from the integration apart from session health and reported in every
verdict, so a disabled plugin shows even when the session says healthy
(lessons 71, 76).

What a case may use depends on the integration. Stock hosts (no Murmo yet)
can run plugin-free cases about typing, pasting, Unicode, newlines and
submitting. Anything else (plugins, Murmo UI, plugin state, offsets, timing
against a control) is skipped with the reason and the phase that adds it,
never passed. Per-host expectation files (`harness/expectations/<integration>/<host>.json`,
owned by the adapter phases) can skip a case for one host or replace fields
of its `expect`.
"""

from __future__ import annotations

import json
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path

from . import evidence, paths
from .drivers.base import DriverRefused
from .hosts import HOSTS
from .hosts.base import Install
from .integrations import Integration
from .session import Run, Session
from .watchdog import ProviderStop

# Steps a stock host cannot be driven through, and who provides them.
STEP_NEEDS = {
    'ime': 'a real input method, which needs a person (phase 30)',
    'fill': 'an adapter: a fill is a programmatic edit (phases 21–24)',
    'history': 'an adapter that can recall host history (phases 21–24)',
    'move': 'an adapter that maps UTF-16 offsets to cursor keys (phases 21–24)',
    'select': 'an adapter that can select (phases 21–24)',
    'state': 'an adapter that drives host state (phases 21–24)',
}
# Expectation fields and the integration feature that can check them.
EXPECT_NEEDS = {
    'ui': 'ui',
    'notices': 'state',
    'stats': 'state',
    'disabled': 'state',
    'enabled': 'state',
    'edits': 'state',
    'storage': 'state',
    'withinMs': 'timing',
}
DRAFT_FIELDS_NEED = {'cursor': 'offsets', 'selection': 'offsets', 'typedSpans': 'offsets'}
SUBMIT_WAIT_SECONDS = 20.0


def expand(spec) -> str:
    """A fixture TextSpec: a string, `{repeat, times}`, or a list of those."""
    if isinstance(spec, str):
        return spec
    if isinstance(spec, list):
        return ''.join(expand(s) for s in spec)
    if isinstance(spec, dict) and 'repeat' in spec:
        return spec['repeat'] * int(spec['times'])
    raise ValueError(f'bad text spec {spec!r}')


def load_suite(path: Path) -> tuple[str, list[dict]]:
    data = json.loads(path.read_text())
    if data.get('kind') != 'editor-ops/v1':
        raise ValueError(f'{path} is not an editor-ops/v1 fixture file')
    defaults = data.get('defaults', {})
    cases = [{**defaults, **case} for case in data['cases']]
    suite = str(path.resolve().relative_to(paths.FIXTURES.resolve()))
    return suite, cases


@dataclass
class Expectations:
    """Per-host overrides: `{"suites": {"<suite>": {"<case>": {"skip": reason} | {"expect": {...}}}}}`."""

    data: dict = field(default_factory=dict)
    source: str | None = None

    @classmethod
    def load(cls, integration: str, host: str, directory: Path = paths.EXPECTATIONS) -> Expectations:
        path = directory / integration / f'{host}.json'
        if not path.exists():
            return cls()
        data = json.loads(path.read_text())
        if data.get('kind') != 'host-expectations/v1' or data.get('host') != host:
            raise ValueError(f'{path}: expected kind host-expectations/v1 for host {host}')
        return cls(data, str(path))

    def for_case(self, suite: str, case_id: str) -> dict:
        return self.data.get('suites', {}).get(suite, {}).get(case_id, {})


@dataclass
class Assertion:
    what: str
    ok: bool
    expected: object = None
    actual: object = None
    source: str = ''  # 'screen' or 'fake-server' or 'integration'

    def as_dict(self) -> dict:
        return {'what': self.what, 'ok': self.ok, 'expected': self.expected, 'actual': self.actual, 'source': self.source}


def _requirement_met(requirement: str, features: dict) -> bool:
    name, _, value = requirement.partition('=')
    if name not in features:
        return False
    return not value or str(features[name]).lower() == value.lower()


class HostSubject:
    """Runs fixture cases on one host version through one driver."""

    def __init__(
        self,
        run: Run,
        host: str,
        install: Install,
        *,
        integration: Integration,
        expectations: Expectations,
        driver: str = 'pty',
        cols: int = 120,
        rows: int = 40,
        attempt: Path,
        platform: str,
    ) -> None:
        self.run = run
        self.host_name = host
        self.host = HOSTS[host]
        self.install = install
        self.integration = integration
        self.expectations = expectations
        self.driver = driver
        self.cols, self.rows = cols, rows
        self.attempt = attempt
        self.platform = platform
        self.ready_screen = None
        self.verdicts: list[dict] = []

    @property
    def name(self) -> str:
        return f'host:{self.host_name}'

    def features(self) -> dict:
        features = {
            'host': self.host_name,
            'host.version': self.install.version,
            'driver': self.driver,
            'platform': self.platform,
            'integration': self.integration.name,
        }
        for feature in self.integration.features:
            features[feature] = True
        return features

    # --- planning ---------------------------------------------------------

    def unsupported(self, case: dict, expect: dict) -> str | None:
        """Why this subject cannot run the case, or None."""
        features = self.features()
        for requirement in case.get('requires', []):
            if not _requirement_met(requirement, features):
                return f'requires {requirement}'
        if case.get('plugins') and 'plugins' not in features:
            return 'loads plugins: needs a Murmo integration (phases 21–24)'
        if case.get('variants') and 'state-steps' not in features:
            return 'state and editor-mode variants need an adapter that drives host state (phases 21–24)'
        if case.get('control') or case.get('timing') or case.get('measure'):
            if 'timing' not in features:
                return 'timing cases need an adapter run against a same-time stock control (phases 21–24, 29)'
        for step in case['steps']:
            kind = next(iter(step))
            if kind in STEP_NEEDS and kind not in features:
                return f'step {kind!r} needs {STEP_NEEDS[kind]}'
            if kind == 'key' and step.get('routing') and 'routing' not in features:
                return 'key routing is observed through an adapter (phases 21–24)'
            if kind == 'burst' and any(d.get('origin') != 'typed' or 'from' in d or 'to' in d for d in step['burst']):
                return 'only typed bursts at the cursor can be driven as keys'
            if kind == 'check':
                reason = self._expect_unsupported(step['check'], features)
                if reason:
                    return reason
        return self._expect_unsupported(expect, features)

    def _expect_unsupported(self, expect: dict, features: dict) -> str | None:
        for key, need in EXPECT_NEEDS.items():
            if key in expect and need not in features:
                return f'expect.{key} needs an integration with {need!r} (phases 21–24)'
        for key, need in DRAFT_FIELDS_NEED.items():
            if key in expect.get('draft', {}) and need not in features:
                return f'expect.draft.{key} needs an integration with {need!r} (phases 21–24)'
        never = expect.get('never', {})
        if 'status' in never and 'ui' not in features:
            return "expect.never.status needs an integration with 'ui' (phases 21–24)"
        if 'thirdParty' in expect and 'plugins' not in features:
            return 'third-party expectations need plugins (phases 21–24, 32)'
        return None

    # --- running ----------------------------------------------------------

    def run_suite(self, suite: str, cases: list[dict], only: list[str] | None = None) -> list[dict]:
        for case in cases:
            if only and case['id'] not in only and not (set(only) & set(case.get('tags', []))):
                continue
            self.verdicts.append(self.run_case(suite, case))
            if self.run.watchdog.stopped:
                break
        return self.verdicts

    def run_case(self, suite: str, case: dict) -> dict:
        """One case on a fresh session. Returns a conformance `Verdict` (the
        JSONL line `packages/conformance compare` reads); the case folder
        holds the full record: checks, screens, requests, plugin state."""
        started = time.monotonic()
        override = self.expectations.for_case(suite, case['id'])
        expect = {**case.get('expect', {}), **override.get('expect', {})}
        variant = f'{self.cols}x{self.rows}'
        verdict = {
            'suite': suite,
            'case': case['id'],
            'variant': variant,
            'subject': self.name,
            'runtime': f'{self.host_name}@{self.install.version}',
            'executor': self.integration.name,
        }
        details = {'driver': self.driver, 'platform': self.platform, 'expectations': self.expectations.source}
        case_dir = self.attempt / 'cases' / f'{case["id"]}~{variant}'
        declared = _matching_skip(case.get('skip'), verdict)
        if declared:
            return self._finish(verdict, details, case_dir, 'skip', [], started, reason=declared['reason'], declared=True)
        if 'skip' in override:
            return self._finish(verdict, details, case_dir, 'skip', [], started, reason=override['skip'], declared=True)
        reason = self.unsupported(case, expect)
        if reason:
            return self._finish(verdict, details, case_dir, 'skip', [], started, reason=reason)
        session: Session | None = None
        assertions: list[Assertion] = []
        mark = self.run.fake.mark()
        try:
            session = self.run.open_session(
                self.host_name, self.install, driver=self.driver, integration=self.integration,
                cols=self.cols, rows=self.rows, label=case['id'][:24],
            )
            if self.ready_screen is None:
                self.ready_screen = session.ready_screen
            details['startupSeconds'] = round(session.startup_seconds or 0, 3)
            session.save(case_dir, 'ready')
            for index, step in enumerate(case['steps']):
                self._step(session, step, mark, assertions, index)
            session.driver.settle(quiet=0.3, timeout=5)
            assertions += self._evaluate(session, expect, mark, 'expect')
            session.save(case_dir, 'final')
            # Per-plugin state, read apart from session health (lessons 71, 76).
            state = self.integration.state(self.host, session.profile).as_dict()
            details['plugins'] = state
            unexpected = sorted(set(state['disabled']) - set(expect.get('disabled', [])))
            if state['plugins']:
                assertions.append(Assertion('plugins.noneUnexpectedlyDisabled', not unexpected, [], unexpected, 'integration'))
            capabilities = self.integration.capabilities(self.host, session.profile)
            if capabilities is not None:
                evidence.write_json(case_dir / 'capabilities.json', capabilities)
            status = 'pass' if assertions and all(a.ok for a in assertions) else 'fail'
            why = None if status == 'pass' else ('no assertions ran' if not assertions else 'assertion failed')
        except ProviderStop as stop:
            status, why = 'fail', f'STOPPED-PROVIDER: {stop}'
        except (DriverRefused, TimeoutError, RuntimeError) as error:
            status, why = 'fail', f'{type(error).__name__}: {error}'.splitlines()[0]
            evidence.write_json(case_dir / 'error.json', {'error': str(error), 'traceback': traceback.format_exc()})
            if session is not None and session.driver is not None:
                session.save(case_dir, 'error')
        finally:
            if session is not None:
                session.close()
        case_dir.mkdir(parents=True, exist_ok=True)
        with (case_dir / 'requests.jsonl').open('w') as handle:
            for record in self.run.fake.since(mark):
                handle.write(json.dumps(record, ensure_ascii=False) + '\n')
        return self._finish(verdict, details, case_dir, status, assertions, started, reason=why)

    def _finish(self, verdict, details, case_dir: Path, status, assertions, started, *, reason=None, declared=False) -> dict:
        verdict.update(status=status, assertions=len(assertions), ms=round((time.monotonic() - started) * 1000))
        if reason:
            verdict['reason'] = reason
        if status == 'skip':
            verdict['declared'] = declared
        evidence.write_json(case_dir / 'verdict.json', {**verdict, **details, 'checks': [a.as_dict() for a in assertions]})
        return verdict

    def _step(self, session: Session, step: dict, mark: int, assertions: list[Assertion], index: int) -> None:
        kind = next(iter(step))
        if kind == 'type':
            session.type(expand(step['type']))
        elif kind == 'burst':
            session.burst(''.join(expand(d['text']) for d in step['burst']))
        elif kind == 'paste':
            session.paste(expand(step['paste']))
            session.driver.settle(quiet=0.3, timeout=5)
        elif kind == 'key':
            session.driver.key(step['key'])
        elif kind == 'submit':
            before = len(self.host.prompt_requests(self.run.fake.since(mark)))
            session.submit(step['submit'])
            if step['submit'] == 'send':
                self._wait_for_prompt(before, mark)
            session.driver.settle(quiet=0.3, timeout=8)
        elif kind == 'settle':
            session.driver.settle(quiet=0.3, timeout=5)
        elif kind == 'waitMs':
            session.driver.drain(step['waitMs'] / 1000)
        elif kind == 'check':
            session.driver.settle(quiet=0.3, timeout=5)
            assertions += self._evaluate(session, step['check'], mark, f'check[{index}]')
        else:
            raise DriverRefused(f'step {kind!r} is not supported by {self.name}')

    def _wait_for_prompt(self, before: int, mark: int) -> None:
        deadline = time.monotonic() + SUBMIT_WAIT_SECONDS
        while time.monotonic() < deadline:
            self.run.watchdog.check()
            if len(self.host.prompt_requests(self.run.fake.since(mark))) > before:
                return
            time.sleep(0.05)

    def _evaluate(self, session: Session, expect: dict, mark: int, where: str) -> list[Assertion]:
        out: list[Assertion] = []
        draft_expect = expect.get('draft', {})
        if draft_expect:
            draft = session.draft()
            if 'text' in draft_expect:
                wanted = expand(draft_expect['text'])
                out.append(Assertion(f'{where}.draft.text', draft == wanted, wanted, draft, 'screen'))
            if 'endsWith' in draft_expect:
                ok = draft is not None and draft.endswith(draft_expect['endsWith'])
                out.append(Assertion(f'{where}.draft.endsWith', ok, draft_expect['endsWith'], draft, 'screen'))
        prompts = [r.get('userText') for r in self.host.prompt_requests(self.run.fake.since(mark))]
        if 'requests' in expect:
            wanted = [expand(t) for t in expect['requests']]
            out.append(Assertion(f'{where}.requests', prompts == wanted, wanted, prompts, 'fake-server'))
        never = expect.get('never', {})
        for needle in never.get('request', []):
            ok = not any(needle in (p or '') for p in prompts)
            out.append(Assertion(f'{where}.never.request', ok, f'no {needle!r}', prompts, 'fake-server'))
        for needle in never.get('draft', []):
            draft = session.draft() or ''
            out.append(Assertion(f'{where}.never.draft', needle not in draft, f'no {needle!r}', draft, 'screen'))
        if 'ui' in expect:
            ui = self.integration.read_ui(self.host, session.driver.screen()) or {}
            for key, wanted in expect['ui'].items():
                out.append(Assertion(f'{where}.ui.{key}', ui.get(key) == wanted, wanted, ui.get(key), 'integration'))
        if any(k in expect for k in ('disabled', 'enabled', 'stats', 'notices')):
            state = self.integration.state(self.host, session.profile).as_dict()
            for plugin in expect.get('disabled', []):
                out.append(Assertion(f'{where}.disabled.{plugin}', plugin in state['disabled'], True, state['disabled'], 'integration'))
            for plugin in expect.get('enabled', []):
                out.append(Assertion(f'{where}.enabled.{plugin}', plugin not in state['disabled'], True, state['disabled'], 'integration'))
            for name, wanted in expect.get('stats', {}).items():
                actual = state['stats'].get(name)
                ok = _count_ok(actual, wanted)
                out.append(Assertion(f'{where}.stats.{name}', ok, wanted, actual, 'integration'))
            if 'notices' in expect:
                out.append(Assertion(f'{where}.notices', state['notices'] == expect['notices'], expect['notices'], state['notices'], 'integration'))
        return out


def _matching_skip(skips, verdict: dict) -> dict | None:
    """A reviewed `skip` entry of the case that names this subject, runtime or
    executor (same matching as packages/conformance)."""
    for entry in skips or []:
        if all(entry.get(k) in (None, verdict[k]) for k in ('runtime', 'executor', 'subject')) and entry.get('trust') in (None, 'builtin'):
            return entry
    return None


def _count_ok(actual, wanted) -> bool:
    if actual is None:
        return False
    if isinstance(wanted, dict):
        return wanted.get('min', actual) <= actual <= wanted.get('max', actual)
    return actual == wanted

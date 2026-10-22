"""Packed-product integration: `murmo setup` in the throwaway profile.

One Integration covers all four hosts. Setup goes through `Run.sandboxed` so
the pre-launch check and the sandbox wrap the CLI and every host command it
spawns. Codex is launched as `murmo codex` with the rule 4 flags still on
the final argv (the Codex host profile puts them there; the wrapper must keep
them).
"""

from __future__ import annotations

import json
from pathlib import Path

from ..integrations import Integration, IntegrationState, PluginState
from ..paths import REPO
from .matrix import PLUGIN_SETS
from .product import PackedProduct, doctor_argv, enable_autocorrect, launcher_path, murmo_data, setup_argv


def _records(host: str) -> dict:
    path = REPO / 'packages' / 'fake-host' / 'records' / f'{host}.json'
    if not path.is_file():
        return {}
    return json.loads(path.read_text())


# Adapters' advertised flags (packages/fake-host/src/records.ts patches). The
# JSON measurement files omit `patch`; claims still need the live advertised
# origin or the oracle fails closed with "no assertions ran".
ADVERTISED = {
    'pi': {'inputOriginEvidence': 'host-labeled', 'ui.dialogSafe': True},
    'opencode': {'inputOriginEvidence': 'host-labeled', 'ui.dialogSafe': False},
    'claude': {'inputOriginEvidence': 'host-labeled', 'ui.dialogSafe': False},
    'codex': {'inputOriginEvidence': 'host-labeled', 'ui.dialogSafe': False},
}


class PackedMurmo(Integration):
    name = 'packed'
    # session_start + english.bin load is async; type before wrap leaves `teh`.
    ready_quiet = 1.0
    features = frozenset({
        'plugins', 'ui', 'state', 'timing', 'inline', 'submit-guard',
        'adapter.coexist', 'adapter.rescue', 'core.inline', 'core.keys',
        'plugin.shortcuts',
    })

    def __init__(self, product: PackedProduct | None, plugin_set: str = 'b') -> None:
        self.product = product
        self.plugin_set = plugin_set
        spec = PLUGIN_SETS[plugin_set]
        extra = []
        if spec.get('autocorrect'):
            extra.append('plugin.autocorrect=release')
        if spec.get('testBuild'):
            extra.append('plugin.test-build')
        self.features = PackedMurmo.features | frozenset(extra)

    def prepare(self, host, profile, run=None) -> None:
        if self.product is None:
            raise RuntimeError('packed-product-missing: set MURMO_PACKED or run pnpm pack')
        spec = PLUGIN_SETS[self.plugin_set]
        if spec.get('testBuild'):
            profile.env['MURMO_PLUGIN_TEST'] = '1'
        if run is None:
            raise RuntimeError('packed integration needs Run to install via murmo setup (sandboxed)')
        argv = setup_argv(self.product)
        result = run.sandboxed(profile, argv, timeout=120)
        if result.code not in (0, None):
            raise RuntimeError(f'murmo setup exited {result.code}: {result.stderr[-2000:]}')
        # After setup so a future installer that writes murmo.toml cannot wipe opt-in.
        if spec.get('autocorrect'):
            enable_autocorrect(profile)
        # The journaled launcher lives under the throwaway HOME.
        local_bin = str(Path(profile.env['HOME']) / '.local' / 'bin')
        path = profile.env.get('PATH', '')
        if local_bin not in path.split(':'):
            profile.env['PATH'] = f'{local_bin}:{path}'
        payload = murmo_data(profile) / 'package'
        if payload.is_dir():
            profile.env['MURMO_PACKAGE_ROOT'] = str(payload)

    def argv(self, host, install, profile, argv: list[str]) -> list[str]:
        # Stock Pi uses --no-extensions (no discovery). Explicit `-e` still
        # loads; without it packed claims typed `teh ` and never became `the`.
        if host.name == 'pi':
            payload = Path(profile.env.get('MURMO_PACKAGE_ROOT') or murmo_data(profile) / 'package')
            entry = payload / 'adapters' / 'pi' / 'index.js'
            if entry.is_file() and '-e' not in argv:
                argv = [*argv, '-e', str(entry)]
            nm = Path(getattr(install, 'dir', '') or '') / 'node_modules'
            if nm.is_dir():
                prior = profile.env.get('NODE_PATH', '')
                profile.env['NODE_PATH'] = f'{nm}:{prior}' if prior else str(nm)
        if host.name != 'codex' or self.product is None:
            return argv
        # The harness launches the npm bin as `node …/codex.js …flags`. murmo-codex
        # resolves stock `codex` on PATH and treats a leading `node` as a prompt
        # (then the .js path as a second positional → pass-through, which stock
        # Codex rejects). Users type `murmo codex [flags]`; pass flags only.
        flags = list(argv)
        if len(flags) >= 2 and Path(flags[0]).name in {'node', 'nodejs'} and 'codex' in Path(flags[1]).name:
            flags = flags[2:]
        launcher = launcher_path(profile)
        if launcher.is_file():
            return [str(launcher), 'codex', *flags]
        plat = getattr(install, 'platform', None)
        if plat is None:
            from .. import paths
            plat = paths.current_platform()
        wrap = self.product.wrapper(plat)
        if wrap.is_file():
            return [str(wrap), *flags]
        return argv

    def logs(self, host, profile) -> list[Path]:
        data = murmo_data(profile)
        found = []
        for path in (data / 'sessions').glob('*.json') if (data / 'sessions').is_dir() else []:
            found.append(path)
        for path in Path(profile.home).glob('murmo-*.jsonl'):
            found.append(path)
        return found

    def state(self, host, profile) -> IntegrationState:
        data = murmo_data(profile)
        sessions = data / 'sessions'
        if not sessions.is_dir():
            return IntegrationState()
        plugins: list[PluginState] = []
        healthy = None
        notices: list[str] = []
        stats: dict[str, int] = {}
        for path in sorted(sessions.glob('*.json')):
            try:
                body = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            if 'healthy' in body:
                healthy = bool(body['healthy']) if healthy is None else (healthy and bool(body['healthy']))
            for raw in body.get('plugins') or []:
                if isinstance(raw, str):
                    plugins.append(PluginState(raw, True))
                    continue
                if not isinstance(raw, dict):
                    continue
                pid = str(raw.get('id') or raw.get('name') or '')
                if not pid:
                    continue
                enabled = raw.get('enabled', raw.get('activated', True)) is not False
                reason = None
                if isinstance(raw.get('fault'), dict):
                    reason = str(raw['fault'].get('kind') or raw['fault'].get('message') or 'fault')
                elif raw.get('disabled_reason'):
                    reason = str(raw['disabled_reason'])
                faults = int(raw.get('faults') or 0)
                plugins.append(PluginState(pid, enabled, reason, faults))
            # store acks: plugins is a map of id → outcome
            ack = body.get('plugins')
            if isinstance(ack, dict):
                for pid, outcome in ack.items():
                    enabled = outcome not in ('disabled', 'error')
                    plugins.append(PluginState(str(pid), enabled, None if enabled else str(outcome)))
            for n in body.get('notices') or body.get('boundaries') or []:
                notices.append(n if isinstance(n, str) else json.dumps(n))
            if isinstance(body.get('stats'), dict):
                stats.update({k: int(v) for k, v in body['stats'].items() if isinstance(v, int)})
        return IntegrationState(healthy=healthy, plugins=plugins, stats=stats, notices=notices)

    def capabilities(self, host, profile) -> dict | None:
        name = host.name if hasattr(host, 'name') else str(host)
        record = _records(name)
        advertised = dict(ADVERTISED.get(name) or {})
        live = None
        data = murmo_data(profile)
        sessions = data / 'sessions'
        if sessions.is_dir():
            for path in sessions.glob('*.json'):
                try:
                    body = json.loads(path.read_text())
                except (OSError, json.JSONDecodeError):
                    continue
                if isinstance(body.get('capabilities'), dict):
                    live = body['capabilities']
                    break
        origin = advertised.get('inputOriginEvidence')
        dialog = advertised.get('ui.dialogSafe')
        if isinstance(live, dict):
            origin = live.get('inputOriginEvidence', origin)
            ui = live.get('ui') if isinstance(live.get('ui'), dict) else None
            if ui and 'dialogSafe' in ui:
                dialog = ui['dialogSafe']
        out = {
            **record,
            **advertised,
            'inputOriginEvidence': origin,
            'ui.dialogSafe': dialog,
            'patch': {'inputOriginEvidence': origin, 'ui': {'dialogSafe': dialog}},
        }
        if live:
            out['live'] = live
        return out or None

    def read_ui(self, host, screen) -> dict | None:
        text = getattr(screen, 'text', '') or ''
        status = None
        if 'helper unavailable' in text.lower() or 'helper-down' in text.lower():
            status = 'helper unavailable'
        ghost = None
        return {'ghost': ghost, 'menu': [], 'status': status, 'screen': text[-2000:]}

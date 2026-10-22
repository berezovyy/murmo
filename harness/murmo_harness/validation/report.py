"""One validation report: `docs/experiments/v1-platform-validation.md`.

A skip is written as skip with its named reason, never as PASS. Failures
become the release-blocker list, each pointed at an owning phase. Tails on a
shared machine are unconfirmed (lesson 65).
"""

from __future__ import annotations

import time
from collections import defaultdict
from pathlib import Path

from .. import paths
from .scenarios import SECTIONS
from .skips import SKIP_REASONS

REPORT_REL = Path('docs/experiments/v1-platform-validation.md')


def report_path(root: Path | None = None) -> Path:
    return (root or paths.REPO) / REPORT_REL


def _cell(row: dict) -> str:
    status = row.get('status', 'skip')
    if status == 'skip':
        reason = (row.get('skip') or {}).get('reason') or row.get('reason') or 'skip'
        return f'skip `{reason}`'
    if status == 'fail':
        return f'FAIL {row.get("reason", "")}'.strip()
    if status == 'limitation':
        return f'limitation: {row.get("reason", "")}'.strip()
    if status == 'unconfirmed':
        return f'unconfirmed: {row.get("reason", "")}'.strip()
    if status == 'pass':
        return 'PASS'
    if status == 'planned':
        return 'planned (would launch)'
    return status


def write_report(run: dict, *, dest: Path | None = None, root: Path | None = None) -> Path:
    """Render the run dict to Markdown. Never writes PASS for a skip."""
    path = dest or report_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = list(run.get('rows') or [])
    pin = run.get('package') or {}
    generated = run.get('generatedAt') or time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    platform = run.get('platform') or ''
    by_section: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_section[row.get('section') or 'other'].append(row)

    live = [r for r in rows if r.get('status') in ('pass', 'fail', 'limitation', 'unconfirmed')]
    skipped = [r for r in rows if r.get('status') == 'skip']
    failed = [r for r in rows if r.get('status') == 'fail']
    passed = [r for r in rows if r.get('status') == 'pass']
    # Honesty: a skip must not appear in passed.
    if any(r.get('status') == 'skip' and r.get('status') == 'pass' for r in rows):
        raise RuntimeError('report writer refused: a row cannot be skip and pass')
    if any(r.get('status') == 'skip' and 'PASS' in str(r.get('reason', '')).upper() for r in rows):
        raise RuntimeError('report writer refused: skip reason looks like a pass')

    lines = [
        '# v1 platform validation',
        '',
        'Packed-product rerun of round 14 load, security, coexistence, soak and',
        'distribution checks (docs/plan/29). Safety: fake model on 127.0.0.1, outbound',
        'network blocked, throwaway HOME, never a real model.',
        '',
        f'- Generated: `{generated}`',
        f'- Platform: `{platform}`',
        f'- Package: version `{pin.get("version", "?")}` sha256 `{pin.get("sha256", "unpinned")}` commit `{pin.get("commit") or "—"}`',
        f'- Rows: {len(rows)} · ran {len(live)} · pass {len(passed)} · fail {len(failed)} · skip {len(skipped)}',
        '',
        'A skip is not a pass. If this machine cannot launch a stock host or the packed',
        'tarball is absent, the row names the reason and the suite does not fake the result.',
        '',
        '## Release blockers',
        '',
    ]
    if not failed:
        lines.append('None open in this run. Remaining skips are listed below, not as passes.')
        lines.append('')
    else:
        lines += [
            '| Row | Owner phase | Failure |',
            '|---|---|---|',
        ]
        for row in failed:
            lines.append(f'| `{row.get("id")}` | {row.get("owner") or "29"} | {row.get("reason", "")} |')
        lines.append('')

    lines += [
        '## Live-host rows vs skipped',
        '',
        '| Status | Count |',
        '|---|---:|',
        f'| ran (pass/fail/limitation/unconfirmed) | {len(live)} |',
        f'| pass | {len(passed)} |',
        f'| fail | {len(failed)} |',
        f'| skip | {len(skipped)} |',
        '',
    ]
    if not live:
        lines += [
            '**No live-host row ran.** Every cell below is a named skip. Re-run',
            '`pnpm harness validate` on a machine with stock host binaries in the harness',
            'cache and a packed tarball (`pnpm pack` / `MURMO_PACKED`).',
            '',
        ]

    for section in SECTIONS:
        group = by_section.get(section) or []
        if not group:
            continue
        lines += [f'## {section}', '', '| Host | Version | OS | Plugin set | Result |', '|---|---|---|---|---|']
        for row in group:
            lines.append(
                f'| {row.get("host")} | {row.get("version")} | {row.get("os")} | {row.get("pluginSet")} | {_cell(row)} |'
            )
        lines.append('')

    lines += [
        '## Named skip reasons',
        '',
        '| Token | Meaning |',
        '|---|---|',
    ]
    used = sorted({(r.get('skip') or {}).get('reason') or r.get('reason') for r in skipped if r.get('status') == 'skip'})
    for token in used:
        if token in SKIP_REASONS:
            lines.append(f'| `{token}` | {SKIP_REASONS[token]} |')
        elif token:
            lines.append(f'| `{token}` | (see row detail) |')
    if not used:
        lines.append('| — | no skips |')
    lines += [
        '',
        '## Method notes',
        '',
        '- Versions freeze from `harness/matrix.toml` at the start of the run; `--version` of each binary is recorded.',
        '- Cold start = fresh profile and fresh helper after `murmo setup`; OS file cache is shared/unflushed (L4).',
        '- Warm start = restart in the same profile. Startup sample: ≥ 10 pairs per row.',
        '- Slow CPU: Linux Docker `--cpus` (0.5 and 1). macOS has no quota (`cpu-quota-unavailable`). Quota ≠ slow laptop (L2).',
        '- Latency cohorts always include a same-time paired control (lesson 65).',
        '- Claude soak characters are paced at 80 ms (r13). The report says so when that row runs.',
        '- OpenCode approval-dialog state is unreadable; status is `prompt.footer` only (lesson 74).',
        '- Third-party peers run only in `docker --network none` (rule 7).',
        '- Outbound audit: loopback trap always; `strace -f -e trace=connect` on Linux when present; macOS sandbox denials as cross-check.',
        '',
    ]
    path.write_text('\n'.join(lines) + '\n')
    return path

"""Murmo's real-host test harness (docs/plan/20-real-host-harness.md).

Runs the stock Claude Code, Codex CLI, OpenCode and Pi at pinned versions
against a fake model server on loopback, with outbound network blocked by the
OS, an isolated temporary HOME, and a watchdog that stops everything if a real
provider hostname shows up. The safety rules are in harness/README.md; every
module here enforces part of them in code.

Python 3.11+ standard library only, plus pyte for the direct-PTY driver's
screen. Test tooling only: nothing here ships in the Murmo package.
"""

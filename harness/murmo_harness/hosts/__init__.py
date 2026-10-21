"""The four host profiles, by name."""

from .base import Canary, HostProfile, Install
from .claude import ClaudeHost
from .codex import CodexHost
from .opencode import OpenCodeHost
from .pi import PiHost

HOSTS: dict[str, HostProfile] = {
    'pi': PiHost(),
    'opencode': OpenCodeHost(),
    'claude': ClaudeHost(),
    'codex': CodexHost(),
}

__all__ = ['HOSTS', 'Canary', 'HostProfile', 'Install']

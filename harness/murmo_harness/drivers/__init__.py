"""Terminal drivers. `tmux` for functional contract tests (what a person in a
multiplexer sees), `pty` for latency and memory (no multiplexer in the path,
lesson 65). Both implement `Driver`."""

from .base import Driver, DriverRefused

__all__ = ['Driver', 'DriverRefused']

"""What a driver sees: the screen's text lines, the cursor and the window title.
Both drivers produce the same view, so host profiles read screens one way."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ScreenView:
    lines: tuple[str, ...]
    cursor: tuple[int, int]  # (column, row), 0-based
    title: str = ''

    @property
    def text(self) -> str:
        return '\n'.join(line.rstrip() for line in self.lines)

    def contains(self, needle: str) -> bool:
        return needle in self.text

    def row(self, y: int) -> str:
        return self.lines[y] if 0 <= y < len(self.lines) else ''

    def cursor_line(self) -> str:
        return self.row(self.cursor[1])

    def find(self, needle: str) -> list[int]:
        """Rows containing `needle`, top to bottom."""
        return [y for y, line in enumerate(self.lines) if needle in line]

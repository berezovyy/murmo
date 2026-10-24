"""Key vocabulary: canonical key IDs (the fixtures' `key` steps) to the bytes
a terminal sends, for the direct-PTY driver, and to tmux key names.

Rules from Phase 0 that live here:
- Escape is always its own write, followed by a gap, never combined with the
  next key (a combined Escape + Ctrl+U write was read ambiguously, r14 H1).
- A newline inside a draft is Ctrl+J, never a modified Enter: tmux 3.3a needs
  `extended-keys always` for those, and Pi's S-Enter arrived as Enter and
  tried to submit (lessons 61, E5, E19).
"""

from __future__ import annotations

ESC = '\x1b'
ESCAPE_GAP_SECONDS = 0.08

# Canonical ID → (PTY bytes, tmux key name).
KEYS: dict[str, tuple[str, str]] = {
    'Enter': ('\r', 'Enter'),
    'Tab': ('\t', 'Tab'),
    'S-Tab': ('\x1b[Z', 'BTab'),
    # The core's canonical name for it (fixtures' `key` steps).
    'Shift+Tab': ('\x1b[Z', 'BTab'),
    'Escape': (ESC, 'Escape'),
    'Backspace': ('\x7f', 'BSpace'),
    'Delete': ('\x1b[3~', 'DC'),
    'space': (' ', 'Space'),
    'Up': ('\x1b[A', 'Up'),
    'Down': ('\x1b[B', 'Down'),
    'Right': ('\x1b[C', 'Right'),
    'Left': ('\x1b[D', 'Left'),
    'Home': ('\x1b[H', 'Home'),
    'End': ('\x1b[F', 'End'),
    'PageUp': ('\x1b[5~', 'PPage'),
    'PageDown': ('\x1b[6~', 'NPage'),
    'F1': ('\x1bOP', 'F1'),
    'F2': ('\x1bOQ', 'F2'),
    'F3': ('\x1bOR', 'F3'),
    'F4': ('\x1bOS', 'F4'),
    'F5': ('\x1b[15~', 'F5'),
    'F6': ('\x1b[17~', 'F6'),
    'F7': ('\x1b[18~', 'F7'),
    'F8': ('\x1b[19~', 'F8'),
    'F9': ('\x1b[20~', 'F9'),
    'F10': ('\x1b[21~', 'F10'),
    'F11': ('\x1b[23~', 'F11'),
    'F12': ('\x1b[24~', 'F12'),
    # Ctrl+J: the newline-in-draft key on every host.
    'Newline': ('\n', 'C-j'),
}
for _letter in 'abcdefghijklmnopqrstuvwxyz':
    KEYS[f'C-{_letter}'] = (chr(ord(_letter) - 96), f'C-{_letter}')
KEYS['C-_'] = ('\x1f', 'C-_')


def pty_bytes(key: str) -> str:
    try:
        return KEYS[key][0]
    except KeyError:
        raise ValueError(f'unknown key {key!r}; known: {", ".join(sorted(KEYS))}') from None


def tmux_name(key: str) -> str:
    try:
        return KEYS[key][1]
    except KeyError:
        raise ValueError(f'unknown key {key!r}') from None


def bracketed(text: str) -> str:
    """A bracketed paste, as a terminal sends it."""
    return f'{ESC}[200~{text}{ESC}[201~'

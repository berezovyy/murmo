"""HOME inventories.

- `tree`: hash, mode and kind of every path under a run's own HOME (synthetic
  data only), for install and uninstall equality (phase 27).
- `real_home`: metadata of the real `~/.claude`, `~/.codex`, `~/.pi`,
  `~/.config/opencode`, `~/.agents`, `~/.npm` and `~/.claude.json` (safety
  rules 10 and 11). It never opens a file and never records a name in
  clear: names are hashed with a salt that lives only in memory, so the
  stored inventory cannot be reversed by guessing names; sizes and mtimes are
  compared as they are.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import stat
from pathlib import Path

from .safety import REAL_HOME_DIRS, REAL_HOME_FILES


def tree(root: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for path in sorted(root.rglob('*')):
        info = path.lstat()
        rel = str(path.relative_to(root))
        entry = {'mode': stat.S_IMODE(info.st_mode)}
        if path.is_symlink():
            entry.update(kind='link', target=os.readlink(path))
        elif path.is_dir():
            entry['kind'] = 'dir'
        else:
            entry.update(kind='file', sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        out[rel] = entry
    return out


def diff(before: dict[str, dict], after: dict[str, dict]) -> dict[str, list[str]]:
    return {
        'added': sorted(k for k in after if k not in before),
        'removed': sorted(k for k in before if k not in after),
        'changed': sorted(k for k in before if k in after and before[k] != after[k]),
    }


class RealHomeInventory:
    """Metadata-only inventory of the real agent folders. Keep one instance for
    before and after: its salt never leaves memory."""

    def __init__(self, home: Path | None = None) -> None:
        self.home = home or Path.home()
        self._salt = secrets.token_bytes(32)

    def _name(self, rel: str) -> str:
        return hashlib.sha256(self._salt + rel.encode('utf-8', 'surrogateescape')).hexdigest()[:24]

    def snapshot(self) -> dict[str, dict]:
        entries: dict[str, dict] = {}
        roots = [self.home / d for d in REAL_HOME_DIRS] + [self.home / f for f in REAL_HOME_FILES]
        for root in roots:
            if not os.path.lexists(root):
                continue
            label = os.path.relpath(root, self.home)  # one of the fixed folder names above
            for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
                for name in [*dirnames, *filenames]:
                    full = os.path.join(dirpath, name)
                    self._add(entries, full, label)
            self._add(entries, str(root), label)
        return entries

    def _add(self, entries: dict[str, dict], full: str, label: str) -> None:
        try:
            info = os.lstat(full)  # metadata only: no file is opened
        except OSError:
            return
        rel = os.path.relpath(full, self.home)
        entries[self._name(rel)] = {
            'root': label,
            'kind': 'link' if stat.S_ISLNK(info.st_mode) else 'dir' if stat.S_ISDIR(info.st_mode) else 'file',
            'size': info.st_size if not stat.S_ISDIR(info.st_mode) else None,
            'mtime_ns': info.st_mtime_ns,
            'mode': stat.S_IMODE(info.st_mode),
        }

    @staticmethod
    def compare(before: dict[str, dict], after: dict[str, dict]) -> dict:
        changes = diff(before, after)
        by_root: dict[str, dict[str, int]] = {}
        for kind, names in changes.items():
            for name in names:
                root = (after.get(name) or before.get(name))['root']
                by_root.setdefault(root, {'added': 0, 'removed': 0, 'changed': 0})[kind] += 1
        return {
            'entries': {'before': len(before), 'after': len(after)},
            'counts': {k: len(v) for k, v in changes.items()},
            # Per agent folder (the folder names are fixed, not private): a
            # live Claude Code session writes ~/.claude by itself.
            'byRoot': by_root,
            # Hashed names only; their salt is gone with this process.
            'changes': changes,
            'identical': not any(changes.values()),
        }

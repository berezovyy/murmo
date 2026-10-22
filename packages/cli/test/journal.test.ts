// Journal atomic write and replay on a temp tree (docs/plan/27).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { homeLayout, inventoryOf, ownedRoots, parentExistence, sha256Bytes } from '../src/home.ts';
import { backupFile, emptyJournal, readJournal, writeJournal } from '../src/journal.ts';
import { replayJournal } from '../src/uninstall.ts';
import { makeHome } from './helpers.ts';

test('replay restores a backed-up file byte-and-mode-exact and deletes created paths', () => {
  const t = makeHome('murmo-journal-');
  try {
    const layout = homeLayout(t.env);
    mkdirSync(layout.dirs.opencode, { recursive: true });
    const seeded = join(layout.dirs.opencode, 'cli.json');
    writeFileSync(seeded, '{"theme":"seeded"}\n', { mode: 0o600 });
    chmodSync(seeded, 0o600);
    const journal = emptyJournal({ version: '0.0.0', sha256: 'ab' });
    journal.before = inventoryOf(ownedRoots(layout));
    journal.parents = parentExistence(layout);
    journal.backup[seeded] = backupFile(seeded);

    writeFileSync(seeded, '{"theme":"installed"}\n');
    mkdirSync(layout.dirs.codex, { recursive: true });
    writeFileSync(join(layout.dirs.codex, 'screen-reader.json'), 'new');
    writeJournal(layout.journal, journal);
    const roundtrip = readJournal(layout.journal);
    assert.equal(roundtrip?.schema, 1);
    replayJournal(journal, layout);
    assert.equal(readFileSync(seeded, 'utf8'), '{"theme":"seeded"}\n');
    assert.equal(sha256Bytes(readFileSync(seeded)), journal.backup[seeded]?.sha256);
  } finally {
    t.remove();
  }
});

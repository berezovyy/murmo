// Enforces the AGENTS.md rule: only the newest 3 attempts of a measurement stay.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { newRun } from '../runs.mjs';

test('a fourth attempt deletes the oldest, keeping the newest 3', () => {
  const base = mkdtempSync(join(tmpdir(), 'murmo-runs-'));
  try {
    const made = [1, 2, 3, 4].map((day) => newRun('soak', { base, now: new Date(`2026-10-0${day}T10:00:00Z`) }));
    const left = readdirSync(join(base, 'soak')).sort();
    assert.deepEqual(
      left,
      made.slice(1).map((p) => p.slice(p.lastIndexOf('/') + 1)),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

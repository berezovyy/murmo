// Stale-result gate: a late lookup for an old revision is dropped (E31).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RevisionGate } from '../src/packed.ts';

test('0 ghosts shown for an old draft revision over 10,000 stale-fuzz runs', () => {
  const gate = new RevisionGate();
  let shown = 0;
  for (let i = 0; i < 10_000; i++) {
    const old = gate.invalidate();
    gate.invalidate();
    if (gate.accepts(old)) shown++;
  }
  assert.equal(shown, 0);
});

test('the current token is accepted until the next invalidate', () => {
  const gate = new RevisionGate();
  const token = gate.invalidate();
  assert.equal(gate.accepts(token), true);
  gate.invalidate();
  assert.equal(gate.accepts(token), false);
});

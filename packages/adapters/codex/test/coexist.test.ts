// Codex outer bindings: $TMUX is unknown, not a conflict, until a witness key
// is missed (E2). Raw injection is documented undetectable.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asSnap, createAdapter } from '../src/js/adapter.ts';
import { TMUX_CONFLICT_TAB, TMUX_PREFIX_TAB } from '../src/js/caps.ts';

function mockHost(snap: unknown) {
  (globalThis as { __host?: (line: string) => string }).__host = (line: string) => {
    const data = JSON.parse(line) as { op: string } & Record<string, unknown>;
    if (data.op === 'snapshot') return JSON.stringify({ snapshot: snap });
    return JSON.stringify({ ok: true, snapshot: snap });
  };
}

const idle = {
  draft: { text: '', cursor: 0, version: 0 },
  state: 'idle',
  known: true,
  title: 'Ready',
  probed: true,
};

test('asSnap reads multiplexer from the wrapper snapshot', () => {
  const snap = asSnap({ ...idle, multiplexer: 'tmux' });
  assert.equal(snap.multiplexer, 'tmux');
  assert.equal(asSnap(idle).multiplexer, null);
});

test('$TMUX records outer-binding as unknown, not a conflict (E2, E7)', async () => {
  mockHost({ ...idle, multiplexer: 'tmux' });
  const adapter = createAdapter((op, data) =>
    JSON.parse((globalThis as unknown as { __host: (s: string) => string }).__host(JSON.stringify({ op, ...data }))),
  );
  await adapter.ready();
  const row = adapter.boundaries.get('outer-binding');
  assert.equal(row?.evidence.kind, 'environment');
  assert.equal(row?.action, 'compose');
  assert.ok(adapter.notices.some((n) => n.includes('unknown')));
  assert.equal(
    adapter.notices.some((n) => n.toLowerCase().includes('conflict')),
    false,
  );
  assert.equal(adapter.caps.coexistence?.keyArbitration, 'murmo-only');
  assert.ok(adapter.boundaries.get('raw-injection')?.evidence.kind === 'undetectable');
});

test('a missed witness Tab with $TMUX names the outer binding (E2)', async () => {
  mockHost({ ...idle, multiplexer: 'tmux' });
  const adapter = createAdapter((op, data) =>
    JSON.parse((globalThis as unknown as { __host: (s: string) => string }).__host(JSON.stringify({ op, ...data }))),
  );
  await adapter.ready();
  adapter.noteWitnessMiss('Tab');
  const rows = adapter.boundaries.records.filter((r) => r.boundary === 'outer-binding');
  assert.ok(rows.some((r) => r.evidence.kind === 'witness-key' && r.evidence.key === 'Tab'));
  assert.ok(adapter.notices.some((n) => n.includes('Tab or F6')));
});

test('documented tmux remedies: prefix bind, not global -n Tab', () => {
  assert.equal(TMUX_PREFIX_TAB.includes('bind-key Tab'), true);
  assert.equal(TMUX_CONFLICT_TAB.includes('bind-key -n Tab'), true);
});

test.skip('Codex + tmux 3.3a and editprompt 1.6.0 (E2, adapter.coexist / harness)', () => {
  // Real multiplexer and editprompt in a Linux --network none container. Never fake-pass.
});

test.skip('Zellij 0.45.1 remains BLOCKED: no recognizable bare Codex prompt through the pyte harness (E11, adapter.coexist / harness)', () => {
  // r14 five attempts plus this phase: keep BLOCKED rather than imply support.
});

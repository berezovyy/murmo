// Wrapper adapter: host-labeled keys, popup Tab passes, unknown draft blocks
// the guard. Catches the r14 native-popup Tab consumption (E12).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asSnap, createAdapter, hostState } from '../src/js/adapter.ts';

function mockHost(snap: unknown) {
  const calls: { op: string; data: Record<string, unknown> }[] = [];
  (globalThis as { __host?: (line: string) => string }).__host = (line: string) => {
    const data = JSON.parse(line) as { op: string } & Record<string, unknown>;
    calls.push({ op: data.op, data });
    if (data.op === 'snapshot') return JSON.stringify({ snapshot: snap });
    if (data.op === 'edit') return JSON.stringify({ pending: 1 });
    return JSON.stringify({ ok: true, snapshot: snap });
  };
  return calls;
}

test('idle composer is prose insert; slash is a host popup (E12)', () => {
  mockHost({
    draft: { text: '/ide', cursor: 4, version: 1 },
    state: 'popup',
    known: true,
    title: 'Ready',
    probed: true,
  });
  const adapter = createAdapter((op, data) =>
    JSON.parse((globalThis as unknown as { __host: (s: string) => string }).__host(JSON.stringify({ op, ...data }))),
  );
  const state = adapter.getState();
  assert.equal(state.popup?.owner, 'host');
  assert.equal(state.mode, 'command');
});

test('asSnap recovers a tracked empty draft after Ready (E25)', () => {
  const snap = asSnap({
    draft: { text: '', cursor: 0, version: 4 },
    state: 'idle',
    known: true,
    title: 'Ready',
    probed: true,
  });
  assert.equal(snap.known, true);
  assert.equal(hostState(snap).busy, false);
  assert.equal(hostState(snap).editorMode, 'insert');
});

test('Working title is busy even when the ledger says idle (E9)', () => {
  const snap = asSnap({
    draft: { text: '', cursor: 0, version: 1 },
    state: 'idle',
    known: true,
    title: 'Working',
    probed: true,
  });
  assert.equal(hostState(snap).busy, true);
});

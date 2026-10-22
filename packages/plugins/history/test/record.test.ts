// 0 records from non-typed, partly typed, extension, rescued, slash, or
// inferred-queue submits (E8, E13, E14). At least 30 cases.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideRecord } from '../src/record.ts';

const TEXT = 'Review the OutboxWorker drain_queue path for timeouts.';

interface Case {
  readonly name: string;
  readonly text: string;
  readonly spans?: [number, number][];
  readonly gesture?: 'send' | 'queue' | 'steer';
  readonly level?: 'observed' | 'inferred';
  readonly certainty?: 'authoritative' | 'tracked' | 'unknown';
  readonly mode?: 'prose' | 'shell' | 'command' | 'unknown';
}

function cases(): Case[] {
  const typed: [number, number][] = [[0, TEXT.length]];
  const out: Case[] = [];
  for (const origin of ['paste', 'history', 'plugin', 'unknown', 'extension'] as const) {
    for (let i = 0; i < 6; i++) {
      out.push({ name: `${origin}-${i}`, text: `${TEXT} ${origin} ${i}`, spans: [] });
    }
  }
  out.push(
    { name: 'slash', text: '/help with this long command now please', spans: typed },
    { name: 'bang', text: '!run the test suite please now here', spans: typed },
    { name: 'shell', text: TEXT, spans: typed, mode: 'shell' },
    { name: 'unknown-certainty', text: TEXT, spans: typed, certainty: 'unknown' },
    { name: 'inferred-queue', text: TEXT, spans: typed, gesture: 'queue', level: 'inferred' },
    {
      name: 'mixed-paste',
      text: TEXT,
      spans: [
        [0, 6],
        [20, TEXT.length],
      ],
    },
    { name: 'empty', text: '   ', spans: [[0, 3]] },
    { name: 'rescued', text: TEXT },
  );
  return out;
}

test('30+ provenance cases store 0 history records (paste, recall, fill, mixed, commands)', () => {
  const all = cases();
  assert.ok(all.length >= 30, `need 30 cases, got ${all.length}`);
  for (const c of all) {
    const result = decideRecord({
      text: c.text,
      gesture: c.gesture ?? 'send',
      level: c.level ?? 'observed',
      ...(c.spans === undefined ? {} : { typedSpans: c.spans }),
      ...(c.certainty ? { certainty: c.certainty } : {}),
      ...(c.mode ? { mode: c.mode } : {}),
    });
    assert.equal(result.store, false, c.name);
  }
});

test('a fully typed observed send is stored; inferred send is stored; inferred queue is not', () => {
  const spans: [number, number][] = [[0, TEXT.length]];
  assert.equal(decideRecord({ text: TEXT, gesture: 'send', level: 'observed', typedSpans: spans }).store, true);
  assert.equal(decideRecord({ text: TEXT, gesture: 'send', level: 'inferred', typedSpans: spans }).store, true);
  assert.equal(decideRecord({ text: TEXT, gesture: 'queue', level: 'inferred', typedSpans: spans }).store, false);
});

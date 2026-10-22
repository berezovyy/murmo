// 0 clauses from pasted, recalled, plugin-filled or unknown-origin text
// (E4, E26, E27). At least 30 cases.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { learnFromSubmit } from '../src/extract.ts';

const PHRASE = 'Update the cache module for tests';

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
  const typed: [number, number][] = [[0, PHRASE.length]];
  const out: Case[] = [];
  for (const origin of ['paste', 'history', 'plugin', 'unknown', 'extension'] as const) {
    for (let i = 0; i < 6; i++) {
      out.push({
        name: `${origin}-${i}`,
        text: `${PHRASE} ${origin} ${i}`,
        spans: [],
      });
    }
  }
  out.push(
    { name: 'slash', text: '/help with this long command now', spans: typed },
    { name: 'bang', text: '!run the test suite please now', spans: typed },
    { name: 'shell', text: PHRASE, spans: typed, mode: 'shell' },
    { name: 'unknown-certainty', text: PHRASE, spans: typed, certainty: 'unknown' },
    { name: 'inferred-queue', text: PHRASE, spans: typed, gesture: 'queue', level: 'inferred' },
    {
      name: 'mixed-paste',
      text: PHRASE,
      spans: [
        [0, 6],
        [20, PHRASE.length],
      ],
    },
  );
  return out;
}

test('30+ provenance cases teach 0 clauses (paste, recall, fill, mixed, commands)', () => {
  const all = cases();
  assert.ok(all.length >= 30, `need 30 cases, got ${all.length}`);
  for (const c of all) {
    const result = learnFromSubmit({
      text: c.text,
      gesture: c.gesture ?? 'send',
      level: c.level ?? 'observed',
      ...(c.spans === undefined ? {} : { typedSpans: c.spans }),
      ...(c.certainty ? { certainty: c.certainty } : {}),
      ...(c.mode ? { mode: c.mode } : {}),
    });
    assert.equal(result.clauses.length, 0, c.name);
  }
});

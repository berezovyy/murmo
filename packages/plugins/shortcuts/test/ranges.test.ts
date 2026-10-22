// Range remap: 10,000 random edits inside, before and after fields; every
// range stays valid or the session ends (E12).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DraftDelta, Range } from '@murmo/api';
import { remapRange } from '../src/session.ts';

function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valid(range: Range, length: number): boolean {
  return (
    Number.isInteger(range[0]) &&
    Number.isInteger(range[1]) &&
    range[0] >= 0 &&
    range[0] < range[1] &&
    range[1] <= length
  );
}

test('10,000 random edit sequences leave field ranges valid or end the session', () => {
  const rand = mulberry(0x37_7e_ed);
  let ended = 0;
  for (let n = 0; n < 10_000; n++) {
    let text = 'AAA<field>BBB<field>CCC';
    const starts = [3, 14];
    const width = '<field>'.length;
    let ranges: Range[] | null = starts.map((s) => [s, s + width]);
    const steps = 1 + Math.floor(rand() * 8);
    for (let s = 0; s < steps && ranges; s++) {
      const kind = rand();
      let delta: DraftDelta;
      if (kind < 0.34) {
        const at = Math.floor(rand() * (text.length + 1));
        delta = { origin: 'typed', from: at, to: at, insert: 'x' };
      } else if (kind < 0.67) {
        const at = Math.floor(rand() * (text.length + 1));
        delta = { origin: 'typed', from: Math.max(0, at - 1), to: at, insert: '' };
      } else {
        const at = Math.floor(rand() * (text.length + 1));
        const to = Math.min(text.length, at + Math.floor(rand() * 4));
        delta = { origin: rand() < 0.2 ? 'paste' : 'typed', from: at, to, insert: rand() < 0.5 ? 'zz' : '' };
      }
      const next: Range[] = [];
      let dead = false;
      for (const range of ranges) {
        const mapped = remapRange(range, [delta]);
        if (!mapped) {
          dead = true;
          break;
        }
        next.push(mapped);
      }
      text = text.slice(0, delta.from) + delta.insert + text.slice(delta.to);
      if (dead) {
        ranges = null;
        ended++;
        break;
      }
      ranges = next;
      for (const range of ranges) assert.ok(valid(range, text.length), `run ${n} range ${range}`);
    }
  }
  assert.ok(ended > 0, 'some sequences must end the session');
});

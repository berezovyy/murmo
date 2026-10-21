import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { r6Dictionary } from '../src/gate/index.ts';
import { PythonRandom } from '../src/gate/python-random.ts';
import { r6SlipStream, readCounts, readFastTyping } from '../src/gate/streams.ts';
import { loadInputs } from '../src/inputs.ts';

test('PythonRandom replays CPython’s random.Random draw for draw', () => {
  // Values from CPython 3.14: `r = random.Random(6002); r.random(), r.randrange(7), r.getrandbits(32) …`.
  // A drift in seeding or randbelow would change the round-6 stream silently.
  const r = new PythonRandom(6002);
  assert.equal(r.random(), 0.7658778367572383);
  assert.equal(r.randrange(7), 0);
  assert.equal(r.getrandbits(32), 2223262151);
  assert.equal(r.choice([...'abcdefghij']), 'j');
  assert.deepEqual(r.choices(['a', 'b', 'c'], [1, 5, 2], 5), ['c', 'b', 'b', 'a', 'b']);
  assert.equal(new PythonRandom(0).random(), 0.8444218515250481);
  assert.equal(new PythonRandom(2 ** 40 + 5).random(), 0.5043802970418443, 'a seed over 32 bits is split into words');
});

test('the seed-6002 stream is regenerated exactly as round 6 made it', () => {
  // Round 6's analyze.py samples(test_counts, 6002, 100000): 400,000 events, SHA-256 of `op\tgood\tbad\n` lines.
  // Proves the gate's "old round-6 stream" is r6's, without committing it or the typos list it filtered against.
  const stream = r6SlipStream(readCounts('test-counts.json'), r6Dictionary(loadInputs()), 6002, 100000);
  assert.equal(stream.length, 400000);
  assert.deepEqual(stream[0], { op: 'swap', slip: { intended: 'synchronous', typed: 'ysnchronous' } });
  const text = stream.map((e) => `${e.op}\t${e.slip.intended}\t${e.slip.typed}\n`).join('');
  assert.equal(
    createHash('sha256').update(text).digest('hex'),
    '4ddea64d6c40c292e12d8206e08a4200acc6b74637b194966cd2f2263f97029b',
  );
});

test('the held-out and clean sets are the moved round-7 and round-8 files', () => {
  // Their sizes are the denominators the gate limits are stated in.
  assert.equal(readFastTyping().length, 51076);
  const clean = readCounts('clean-400k-counts.json');
  assert.equal(
    Object.values(clean).reduce((a, b) => a + b, 0),
    400000,
  );
});

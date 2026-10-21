// 10,000 seeded interleavings of submit, delayed edits, typing during a
// pending decision and late commits. Catches a stale version reaching the
// fake transport, or a committed event dropped when the next key arrives
// (docs/plan/08 fuzz; lesson 72).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SubmitCommitted } from '@murmo/api';
import { createHarness, type DirectPluginSpec } from '../src/testing/index.ts';

function xorshift32(seed: number) {
  let state = seed | 0;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
}

test('10,000 seeded streams: 0 stale sends and 0 lost committed events (plan/08 fuzz)', async () => {
  const events: SubmitCommitted[] = [];
  const late: DirectPluginSpec = {
    id: 'late',
    builtin: false,
    factory: () => ({
      name: 'late',
      version: '1',
      permissions: ['draft:read', 'draft:write'],
      async onChange(change, ctx) {
        if (change.origin !== 'typed' || !change.draft.text.endsWith('z')) return [];
        const version = change.draft.version;
        await ctx.clock.sleep(5, ctx.signal);
        return [
          {
            type: 'edit' as const,
            edit: { from: 0, to: change.draft.text.length, insert: 'STALE', baseVersion: version, undoable: true },
          },
        ];
      },
    }),
  };
  const observer: DirectPluginSpec = {
    id: 'obs',
    builtin: true,
    factory: () => ({
      name: 'obs',
      version: '1',
      permissions: ['submit:observe', 'draft:read'],
      onSubmitCommitted(event) {
        events.push(event);
      },
    }),
  };
  const h = await createHarness({ plugins: [late, observer] });
  const rng = xorshift32(0x08c0ffee);
  let raced = 0;
  for (let i = 0; i < 10_000; i++) {
    const op = rng.int(6);
    if (op === 0) await h.driver.type(rng.pick(['a', 'b', 'c']), false);
    else if (op === 1) {
      // Type the delayed-edit trigger and submit before the 5 ms sleep; the
      // request must be the snapshot, not STALE (S1 last-moment).
      await h.driver.type('z', false);
      const snap = h.adapter.getDraft().text;
      await h.driver.submit('send');
      await h.driver.settle();
      raced++;
      assert.equal(h.adapter.requests.at(-1)?.text, snap, `stale send on stream ${i}`);
    } else if (op === 2) {
      await h.driver.submit('send');
      await h.driver.settle();
    } else if (op === 3) await h.driver.submit('newline');
    else if (op === 4) await h.driver.wait(rng.int(8));
    else await h.driver.key(rng.pick(['x', 'Backspace']));
  }
  await h.driver.settle();
  assert.ok(raced > 0, 'generator never raced a delayed edit against submit');
  assert.equal(
    events.length,
    h.adapter.requests.length,
    `lost committed events: ${events.length} events, ${h.adapter.requests.length} requests`,
  );
});

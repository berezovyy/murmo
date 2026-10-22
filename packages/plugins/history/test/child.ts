// Writer for the history merge crash test: prints "ready" after the first
// snapshot set swap, then keeps merging until killed.
import { createHash } from 'node:crypto';
import { openStore } from '@murmo/store/node';
import { persistEvents, writePacked } from '../src/node/store.ts';
import type { HistoryRecord } from '../src/rank.ts';

const [data, state, cache] = process.argv.slice(2);
if (!data || !state || !cache) throw new Error('usage: child.ts <data> <state> <cache>');
const store = await openStore({ roots: { data, state, cache } });
const hex = (n: number) => createHash('sha256').update(String(n)).digest('hex');
let ready = false;
const announce = () => {
  if (ready) return;
  ready = true;
  process.stdout.write('ready\n');
};

for (let n = 0; ; n++) {
  const text = `Review the cache module for scenario ${n} with one undo step.`;
  await persistEvents(store, 'crash', [{ text, host: 'fake', project: hex(n), at: n }]);
  const records: HistoryRecord[] = [
    {
      id: 0,
      text,
      count: 1,
      lastAt: n,
      events: [{ host: 'fake', project: hex(n), at: n }],
    },
  ];
  await writePacked(store, records, Date.now());
  announce();
}

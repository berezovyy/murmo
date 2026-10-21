// A store writer in its own process, for the crash and concurrency tests (and
// tools/store-parity.mjs, which mixes it with the Rust store-tool):
//
//   node child.ts <data> <state> <cache> write-loop <trust|words|plugin|meta>
//   node child.ts <data> <state> <cache> sets <plugin> <prefix> <keys> <rounds>
//   node child.ts <data> <state> <cache> swap-loop <directory>
//
// The loops print "ready" once their first write is on disk and run until killed.
import { createHash } from 'node:crypto';
import { pluginRecordPath } from '../src/layout.ts';
import { openStore, swapSnapshotSet, updateRecord } from '../src/node/index.ts';
import type { RecordKind } from '../src/records.ts';

const [data, state, cache, mode, ...rest] = process.argv.slice(2);
if (!data || !state || !cache || !mode) throw new Error('usage: child.ts <data> <state> <cache> <mode> ...');
const store = await openStore({ roots: { data, state, cache } });
const hex = (n: number) => createHash('sha256').update(String(n)).digest('hex');
let ready = false;
const announce = () => {
  if (ready) return;
  ready = true;
  process.stdout.write('ready\n');
};

/** A valid record of `kind` whose size changes with `n` (the Rust tool writes the same shapes). */
function sample(kind: string, n: number): Record<string, unknown> {
  const id = hex(n);
  switch (kind) {
    case 'trust':
      return {
        schema: 1,
        approvals: {
          [id]: {
            projectId: id,
            root: '/r',
            dev: '1',
            ino: String(n),
            fingerprint: id,
            approvedAt: n,
            shortcutCount: n % 1000,
          },
        },
      };
    case 'words':
      return { schema: 1, words: Array.from({ length: n % 500 }, (_, i) => `w${i}`) };
    case 'plugin':
      return { schema: 1, plugin: 'crash', data: { n, pad: 'x'.repeat(n % 4000) } };
    default:
      return { schema: 1, epoch: id.slice(0, 32), generation: n };
  }
}

const layout = store.layout;
if (mode === 'write-loop') {
  const kind = rest[0] ?? '';
  const [recordKind, path] = (
    {
      trust: ['trust', layout.trust],
      words: ['words', layout.words],
      plugin: ['plugin', pluginRecordPath(layout, 'crash')],
      meta: ['meta', layout.meta],
    } as Record<string, [RecordKind, string]>
  )[kind] ?? [undefined, undefined];
  if (!recordKind || !path) throw new Error(`unknown kind ${kind}`);
  const durable = kind === 'trust' || kind === 'words';
  for (let n = 0; ; n++) {
    const outcome = await updateRecord(
      recordKind,
      path,
      () => ({ record: sample(kind, n) as never, result: undefined }),
      {
        base: data,
        durable,
      },
    );
    if (outcome.status === 'error') throw new Error(outcome.reason);
    announce();
  }
} else if (mode === 'sets') {
  const [plugin = '', prefix = '', keys = '0', rounds = '0'] = rest;
  const storage = store.plugins.forPlugin(plugin);
  for (let round = 0; round < Number(rounds); round++) {
    for (let k = 0; k < Number(keys); k++) {
      const result = await storage.set(`${prefix}-${k}`, round);
      if (result.status !== 'ok') {
        process.stderr.write(`set failed: ${JSON.stringify(result)}\n`);
        process.exit(1);
      }
    }
  }
} else if (mode === 'swap-loop') {
  const directory = rest[0] ?? '';
  for (let n = 1; ; n++) {
    // Every file of one set carries the same tag; a reader that sees two tags saw two generations.
    const file = (name: string) => ({
      fields: { format: 'murmo-test-v1', sourceHash: hex(n), tag: n },
      body: new TextEncoder().encode(`${name}:${n}:`.repeat(1 + ((n * 37) % 2000))),
    });
    const outcome = await swapSnapshotSet(
      { directory, base: data },
      { 'a.snap': file('a'), 'b.snap': file('b'), 'c.snap': file('c') },
    );
    if (outcome.status === 'ok') announce();
  }
} else if (mode === 'draft-loop') {
  const [project = '', host = 'fake', session = 'crash'] = rest;
  const id = { project, host: host as 'fake', session };
  for (let n = 0; ; n++) {
    const text = `draft-${n}-${'x'.repeat(n % 400)}`;
    const result = await store.drafts.save(id, { text, cursorUTF16: text.length, revision: n });
    if (result.status === 'error') throw new Error(result.reason);
    if (result.status === 'ok') announce();
  }
} else {
  throw new Error(`unknown mode ${mode}`);
}

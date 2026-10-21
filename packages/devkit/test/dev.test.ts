// dev lifecycle: type abc, reload, type x, broken module, type y → abcxy,
// 0 subscriptions after exit (E3).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { pluginDev, type TimelineEvent } from '../src/plugin-dev.ts';
import { pluginNew } from '../src/plugin-new.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Collect extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.chunks.push(String(chunk));
    cb();
  }
  events(): TimelineEvent[] {
    const out: TimelineEvent[] = [];
    for (const line of this.chunks.join('').split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as TimelineEvent);
      } catch {
        /* incomplete line */
      }
    }
    return out;
  }
}

const plugin = (body: string) => `export default () => ({
  name: 'hello',
  version: '0.1.0',
  permissions: ['draft:read'],
  onChange(change, ctx) {
    ${body}
  },
});
`;

async function waitFor(output: Collect, kind: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (output.events().some((e) => e.kind === kind)) return;
    await delay(40);
  }
  throw new Error(
    `timed out waiting for ${kind}: ${
      output
        .events()
        .map((e) => e.kind)
        .join(',') || '(no events)'
    }`,
  );
}

test('dev keeps the draft across reload and rollback, then disposes subscriptions', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'murmo-dev-'));
  const dir = await pluginNew('hello', parent);
  await writeFile(
    join(dir, 'plugin.mjs'),
    plugin('return [{ type: "status", text: "g1", baseVersion: ctx.draft.version }];'),
  );

  const input = new Readable({ read() {} });
  const push = (line: string) => input.push(`${line}\n`);
  const output = new Collect();
  const running = pluginDev(dir, { input, output });
  try {
    await waitFor(output, 'ready');
    push('type abc');
    await delay(120);
    await writeFile(
      join(dir, 'plugin.mjs'),
      plugin('return [{ type: "status", text: "g2", baseVersion: ctx.draft.version }];'),
    );
    await waitFor(output, 'reloaded');
    push('type x');
    await delay(120);
    await writeFile(join(dir, 'plugin.mjs'), 'throw new Error("broken module");\n');
    const manifest = JSON.parse(await readFile(join(dir, 'murmo.plugin.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(dir, 'murmo.plugin.json'), `${JSON.stringify({ ...manifest, version: '0.1.1' }, null, 2)}\n`);
    await waitFor(output, 'reload-rejected');
    push('type y');
    await delay(120);
  } finally {
    push('quit');
    input.push(null);
  }

  const timeline = await running;
  const closed = timeline.find((e) => e.kind === 'closed');
  assert.ok(closed);
  assert.equal(closed.subscriptions, 0);
  const observes = timeline.filter((e) => e.kind === 'observe');
  const last = observes.at(-1) as { draft?: { text?: string } };
  assert.equal(last?.draft?.text, 'abcxy');
  assert.ok(timeline.some((e) => e.kind === 'reloaded'));
  assert.ok(timeline.some((e) => e.kind === 'reload-rejected'));
  assert.ok(observes.some((e) => String(e.status ?? '').includes('g2')));
});

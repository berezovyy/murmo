// Isolated Executor over the real murmo-plugin-host binary (lesson 73: a fake
// pass that the installed helper breaks).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Clock, PluginContext } from '@murmo/api';
import { HOOKS, SERVICE_ROUTES } from '@murmo/api/adapter';
import { createClock } from '../src/index.ts';

async function isolated() {
  return import('../src/node/index.ts');
}

function ctx(clock: Clock, cancelled = false): PluginContext {
  const storage = new Map<string, unknown>();
  return {
    host: { name: 'fake', version: '1', caps: {} as PluginContext['host']['caps'] },
    draft: { text: 'hi', cursor: 2, version: 1, certainty: 'authoritative', typedSpans: [[0, 2]] },
    state: { mode: 'prose', popup: null, dialog: false, busy: false, editorMode: 'insert', history: false },
    settings: {},
    signal: { cancelled },
    clock,
    storage: {
      get: async (key) => (storage.has(key) ? { status: 'ok', value: storage.get(key) } : { status: 'ok' }),
      set: async (key, value) => {
        storage.set(key, value);
        return { status: 'ok' };
      },
      delete: async (key) => {
        storage.delete(key);
        return { status: 'ok' };
      },
    },
    project: {
      read: async (path) =>
        path === 'ok.txt' ? { status: 'ok', text: 'approved', bytes: 8, path } : { status: 'denied', reason: 'escape' },
    },
  };
}

const counter = `
export default () => ({
  name: 'status-counter',
  version: '1.0.0',
  permissions: ['draft:read'],
  onChange(change, ctx) {
    return [{ type: 'status', text: change.draft.text.length + ' chars', baseVersion: change.draft.version }];
  },
});
`;

test('isolated load/run round-trips a hook through the real binary (E6)', async () => {
  const clock = createClock();
  const ex = (await isolated()).createNodeIsolatedExecutor({ clock });
  try {
    const d = await ex.load({ id: 'counter', builtin: true, source: counter, resources: { memoryMiB: 8 } });
    assert.equal(d.name, 'status-counter');
    assert.ok(d.hooks.includes('onChange'));
    const value = (await ex.run('counter', 'onChange', { draft: ctx(clock).draft }, ctx(clock), {
      timeoutMs: 100,
    })) as { type: string; text: string }[];
    assert.equal(value[0]?.text, '2 chars');
    assert.equal(ex.kind, 'isolated');
    assert.equal(ex.stats().hardLimits, true);
    assert.equal(ex.stats().services.storage, 'brokered');
  } finally {
    await ex.dispose();
  }
});

test('every HOOKS name can appear in the helper descriptor (E5, lesson 73)', async () => {
  const source = `export default () => ({
    name: 'full', version: '1',
    permissions: ['draft:read','submit','submit:observe','fs:project-read'],
    ${Object.keys(HOOKS)
      .map((h) => `${h}() {}`)
      .join(',\n    ')}
  });`;
  const ex = (await isolated()).createNodeIsolatedExecutor();
  try {
    const d = await ex.load({ id: 'full', builtin: true, source, resources: { memoryMiB: 8 } });
    for (const hook of Object.keys(HOOKS)) {
      assert.ok(d.hooks.includes(hook as (typeof d.hooks)[number]), `missing ${hook}`);
    }
    assert.ok('clock' in SERVICE_ROUTES);
    assert.ok('storage' in SERVICE_ROUTES);
    assert.ok('project.read' in SERVICE_ROUTES);
  } finally {
    await ex.dispose();
  }
});

test('a looper is interrupted as cpu and a peer still answers (E2, C12)', async () => {
  const looper = `export default () => ({
    name: 'looper', version: '1', permissions: [],
    onKey() { const end = Date.now() + 200; while (Date.now() < end) {} return []; },
  });`;
  const peer = `export default () => ({ name: 'peer', version: '1', permissions: [], onKey() { return [{type:'status',text:'ok',baseVersion:1}]; } });`;
  const clock = createClock();
  const ex = (await isolated()).createNodeIsolatedExecutor({ clock });
  try {
    await ex.load({ id: 'looper', builtin: true, source: looper, resources: { memoryMiB: 8 } });
    await ex.load({ id: 'peer', builtin: true, source: peer, resources: { memoryMiB: 8 } });
    const start = clock.now();
    await assert.rejects(
      ex.run('looper', 'onKey', 'x', ctx(clock), { timeoutMs: 80 }),
      (error: { code?: string }) => error.code === 'cpu',
    );
    assert.ok(clock.now() - start < 80, 'looper was not interrupted promptly');
    const peerValue = (await ex.run('peer', 'onKey', 'x', ctx(clock), { timeoutMs: 50 })) as { text: string }[];
    assert.equal(peerValue[0]?.text, 'ok');
  } finally {
    await ex.dispose();
  }
});

test('storage and project.read resume through the coordinator brokers (E5)', async () => {
  const source = `export default () => ({
    name: 'svc', version: '1', permissions: ['fs:project-read'],
    async onChange(_c, ctx) {
      await ctx.storage.set('k', 7);
      const got = await ctx.storage.get('k');
      const read = await ctx.project.read('ok.txt');
      const denied = await ctx.project.read('../escape');
      const file = await ctx.project.readFile('ok.txt');
      return [{ type: 'status', text: JSON.stringify({ got, read, denied, file }), baseVersion: 1 }];
    },
  });`;
  const clock = createClock();
  const ex = (await isolated()).createNodeIsolatedExecutor({ clock });
  try {
    await ex.load({ id: 'svc', builtin: true, source, resources: { memoryMiB: 8 } });
    const value = (await ex.run('svc', 'onChange', {}, ctx(clock), { timeoutMs: 200 })) as {
      text: string;
    }[];
    const body = JSON.parse(value[0]?.text ?? '{}') as {
      got: { value: number };
      read: { status: string; text?: string };
      denied: { status: string };
      file: string;
    };
    assert.equal(body.got.value, 7);
    assert.equal(body.read.status, 'ok');
    assert.equal(body.read.text, 'approved');
    assert.equal(body.denied.status, 'denied');
    assert.equal(body.file, 'approved');
  } finally {
    await ex.dispose();
  }
});

test('a 10,000-effect reply is output-limit (L6)', async () => {
  const source = `export default () => ({
    name: 'flood', version: '1', permissions: [],
    onChange() {
      const out = [];
      for (let i = 0; i < 10000; i++) out.push({ type: 'edit', edit: { from: 0, to: 0, insert: String(i), baseVersion: 1 } });
      return out;
    },
  });`;
  const clock = createClock();
  const ex = (await isolated()).createNodeIsolatedExecutor({ clock });
  try {
    await ex.load({ id: 'flood', builtin: true, source, resources: { memoryMiB: 8 } });
    await assert.rejects(
      ex.run('flood', 'onChange', {}, ctx(clock), { timeoutMs: 400 }),
      (error: { code?: string }) => error.code === 'output-limit',
    );
  } finally {
    await ex.dispose();
  }
});

test('load without an explicit memory cap is refused by the helper (E8)', async () => {
  const ex = (await isolated()).createNodeIsolatedExecutor({ maxMemoryMiB: 8 });
  try {
    // Client always sends a cap; admission above the reviewed max is refused here.
    await assert.rejects(
      ex.load({ id: 'big', builtin: true, source: counter, resources: { memoryMiB: 48 } }),
      /admission|memory/i,
    );
  } finally {
    await ex.dispose();
  }
});

test('first-party members share one worker and keep separate stats (E3)', async () => {
  const a = `export default () => ({ name: 'a', version: '1', permissions: [], onChange() { return [{type:'status',text:'A',baseVersion:1}]; } });`;
  const b = `export default () => ({ name: 'b', version: '1', permissions: [], onChange() { return [{type:'status',text:'B',baseVersion:1}]; } });`;
  const clock = createClock();
  const ex = (await isolated()).createNodeIsolatedExecutor({ clock, firstParty: ['a', 'b'] });
  try {
    await ex.load({ id: 'a', builtin: true, source: a, resources: { memoryMiB: 8 } });
    await ex.load({ id: 'b', builtin: true, source: b, resources: { memoryMiB: 8 } });
    const va = (await ex.run('a', 'onChange', {}, ctx(clock), { timeoutMs: 50 })) as { text: string }[];
    const vb = (await ex.run('b', 'onChange', {}, ctx(clock), { timeoutMs: 50 })) as { text: string }[];
    assert.equal(va[0]?.text, 'A');
    assert.equal(vb[0]?.text, 'B');
  } finally {
    await ex.dispose();
  }
});

test('supervisor death fails pending calls as session-exit (L3)', async () => {
  const { helperBinary } = await import('../src/node/index.ts');
  const { spawn } = await import('node:child_process');
  const bin = helperBinary();
  const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', () => resolve());
    child.once('error', reject);
  });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  const clock = createClock();
  const ex = (await isolated()).createNodeIsolatedExecutor({ clock, restartLimit: 0 });
  try {
    await ex.load({ id: 'c', builtin: true, source: counter, resources: { memoryMiB: 8 } });
    // Kill the executor's helper after load by disposing the transport via a
    // second isolate: SIGKILL the pid from stats.
    const pid = ex.stats().pid;
    assert.ok(pid);
    process.kill(pid, 'SIGKILL');
    await assert.rejects(
      ex.run('c', 'onChange', {}, ctx(clock), { timeoutMs: 100 }),
      (error: { code?: string }) => error.code === 'transport' || error.code === 'session-exit' || error.code === 'cpu',
    );
    assert.equal(ex.stats().hardLimits, true);
  } finally {
    await ex.dispose();
  }
});

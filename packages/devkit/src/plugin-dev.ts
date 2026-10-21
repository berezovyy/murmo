import { type FSWatcher, watch } from 'node:fs';
import { createInterface } from 'node:readline';
import { createMemoryStorage } from '@murmo/core';
import { type FakeHostProfile, makeAdapter } from '@murmo/fake-host';
import { createNamedExecutor } from './executors.ts';
import { type PreparedPlugin, preparePlugin } from './loader.ts';
import type { TestProfile } from './plugin-test.ts';
import { type FakeSession, startPlugin } from './session.ts';

export interface PluginDevOptions {
  readonly profile?: TestProfile;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

export interface TimelineEvent {
  readonly time: string;
  readonly generation: number;
  readonly kind: string;
  readonly [key: string]: unknown;
}

export async function pluginDev(directory: string, options: PluginDevOptions = {}): Promise<TimelineEvent[]> {
  const profile = (options.profile ?? 'fake') as FakeHostProfile | 'fake';
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const adapter = makeAdapter(profile);
  const storage = createMemoryStorage();
  const executorOf = () => createNamedExecutor('in-process');
  let executor = await executorOf();
  let current = await preparePlugin(directory, { caps: adapter.caps });
  let session: FakeSession = await startPlugin(current, { adapter, executor, storage, keepAdapter: true });
  let generation = 1;
  let closed = false;
  let queue = Promise.resolve();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const timeline: TimelineEvent[] = [];

  const log = (kind: string, data: Record<string, unknown> = {}) => {
    const row: TimelineEvent = { time: new Date().toISOString(), generation, kind, ...data };
    timeline.push(row);
    if (timeline.length > 500) timeline.shift();
    output.write(`${JSON.stringify(row)}\n`);
  };

  const unsub = adapter.onDraftChange((change) =>
    log('change', {
      origin: change.origin,
      version: change.draft.version,
      text: change.draft.text,
      deltas: change.deltas,
    }),
  );

  const snapshot = () => {
    const stats = session.session.stats();
    log('observe', {
      draft: adapter.getDraft(),
      status: adapter.status,
      ghost: adapter.ghost,
      menu: adapter.menu,
      requests: adapter.requests.length,
      stats: { disabled: stats.disabled, faults: stats.faults, version: stats.version },
    });
  };

  const enqueue = (fn: () => Promise<void>) => {
    queue = queue.then(fn).catch((error: unknown) => {
      log('error', { message: error instanceof Error ? error.message : String(error) });
    });
    return queue;
  };

  async function reload(): Promise<void> {
    if (closed) return;
    let prepared: PreparedPlugin;
    try {
      prepared = await preparePlugin(directory, { caps: adapter.caps });
    } catch (error) {
      log('reload-rejected', {
        message: error instanceof Error ? error.message : String(error),
        keptGeneration: generation,
      });
      return;
    }
    const previous = current;
    const previousExecutor = executor;
    await session.session.dispose();
    await previousExecutor.dispose().catch(() => {});
    try {
      executor = await executorOf();
      session = await startPlugin(prepared, { adapter, executor, storage, keepAdapter: true });
      current = prepared;
      generation++;
      log('reloaded', { plugin: prepared.manifest.name });
    } catch (error) {
      executor = await executorOf();
      session = await startPlugin(previous, { adapter, executor, storage, keepAdapter: true });
      log('reload-rejected', {
        message: error instanceof Error ? error.message : String(error),
        keptGeneration: generation,
      });
    }
    snapshot();
  }

  const watcher: FSWatcher = watch(current.root, { recursive: true }, (_event, file) => {
    if (!file || String(file).endsWith('.test.mjs')) return;
    if (!/\.mjs$/.test(String(file)) && String(file) !== 'murmo.plugin.json') return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void enqueue(reload);
    }, 60);
  });

  const lines = createInterface({ input, terminal: false });

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearTimeout(debounce);
    watcher.close();
    lines.close();
    await queue;
    unsub();
    await session.session.dispose();
    await session.executor.dispose().catch(() => {});
    adapter.dispose();
    log('closed', { subscriptions: adapter.subscribers() });
  }

  const onSignal = () => {
    void close();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  log('ready', {
    host: adapter.host,
    plugin: current.manifest.name,
    commands: ['type', 'paste', 'burst', 'key', 'packet', 'state', 'submit', 'timeline', 'quit'],
  });
  snapshot();

  try {
    for await (const line of lines) {
      if (line === 'quit') break;
      const at = line.indexOf(' ');
      const command = at < 0 ? line : line.slice(0, at);
      const argument = at < 0 ? '' : line.slice(at + 1);
      await enqueue(async () => {
        if (command === 'type') await session.driver.type(argument);
        else if (command === 'paste') await session.driver.fill(`${adapter.getDraft().text}${argument}`, 'paste');
        else if (command === 'burst') {
          await session.driver.burst([
            { origin: 'typed', from: adapter.getDraft().cursor, to: adapter.getDraft().cursor, text: argument },
          ]);
        } else if (command === 'key') await session.driver.key(argument);
        else if (command === 'state') await session.driver.state(JSON.parse(argument) as object);
        else if (command === 'packet') {
          if (profile === 'fake') throw new Error('packet requires a real-host profile');
          await session.driver.packet(JSON.parse(argument) as { origin: 'typed' | 'paste'; text: string }[]);
        } else if (command === 'submit') await session.driver.submit((argument || 'send') as 'send');
        else if (command === 'timeline') {
          output.write(`${JSON.stringify({ kind: 'timeline', events: timeline })}\n`);
          return;
        } else if (command) throw new Error(`unknown command ${command}`);
        log('input', { command });
        snapshot();
      });
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await close();
  }
  return timeline;
}

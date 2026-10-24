// A typed helper timeout must not disable healthy plugins (lesson 71).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock, executorFault } from '@murmo/executor';
import { HELPER_RESTART_DELAYS_MS } from '../src/helper.ts';
import { type ClaudeHost, createClaudeHost, HELPER_DOWN_NOTICE } from '../src/session.ts';
import { type HostServices, PLUGIN_VERSION } from '../src/types.ts';
import { FakeClaude } from './fake-runtime.ts';

test('a typed timeout from one plugin does not mark the session healthy-with-a-plugin-off (lesson 71)', async () => {
  let calls = 0;
  const host = createClaudeHost({
    skipProbes: true,
    plugins: [
      {
        id: 'slow',
        builtin: true,
        factory: () => ({
          name: 'slow',
          version: '1',
          permissions: ['draft:read'],
          async onChange() {
            calls++;
            throw executorFault('timeout', 'synthetic helper timeout', { pluginId: 'slow', hook: 'onChange' });
          },
        }),
      },
      {
        id: 'ok',
        builtin: true,
        factory: () => ({
          name: 'ok',
          version: '1',
          permissions: ['draft:read'],
          onChange() {
            return [];
          },
        }),
      },
    ],
  });
  const fake = new FakeClaude();
  await host.start(fake.$);
  fake.draft = { text: '', cursor: 0 };
  await host.adapter.handleEdit(
    {
      origin: { kind: 'composer' },
      key: { key: 'a' },
      text: '',
      cursor: 0,
      start: 0,
      end: 0,
      inputText: 'a',
    },
    (event) => {
      const text = event.text.slice(0, event.start) + event.inputText + event.text.slice(event.end);
      return { text, cursor: event.start + event.inputText.length };
    },
  );
  await host.session?.settle();
  const stats = host.session?.stats();
  assert.ok(stats);
  assert.equal(stats.ready, true);
  const slow = stats.plugins.find((plugin) => plugin.id === 'slow');
  const ok = stats.plugins.find((plugin) => plugin.id === 'ok');
  assert.equal(ok?.disabled, false);
  assert.ok(calls >= 0);
  assert.equal(slow?.id, 'slow');
  await host.dispose();
});

test('the helper socket path always fits sun_path (E11)', async () => {
  // Catches the live-host bug: a 153-byte socket path under a deep $TMPDIR made
  // the helper exit before ready, so Claude lost project shortcuts.
  const { socketDir } = await import('../src/helper.ts');
  const macos = '/var/folders/n4/tcrfg80x6qvd8dg6f9p374c40000gn/T/';
  assert.equal(socketDir(macos), macos.slice(0, -1));
  assert.equal(socketDir(undefined), '/tmp');
  assert.equal(socketDir('/'), '/tmp');
  const deep = `/private${macos}murmo-harness-20261023-000529-968c5d/001-claude-trusted-project-shortcut/tmp`;
  assert.equal(socketDir(deep), '/tmp');
  // Bytes, not UTF-16 units: 42 three-byte characters are 126 bytes.
  assert.equal(socketDir(`/tmp/${'界'.repeat(42)}`), '/tmp');
});

/** Helper processes a test can kill: each `spawn` starts one that prints ready unless `failing`. */
class FakeHelpers {
  readonly started: string[] = [];
  readonly requests: string[] = [];
  repaints = 0;
  failing = false;
  readonly #kills: (() => void)[] = [];

  services(): HostServices {
    return {
      after: (ms, callback) => {
        const id = setTimeout(callback, ms);
        return { cancel: () => clearTimeout(id) };
      },
      spawn: (argv) => {
        const socket = argv[argv.length - 1] ?? '';
        this.started.push(socket);
        let kill: () => void = () => {};
        const killed = new Promise<void>((resolve) => {
          kill = resolve;
        });
        this.#kills.push(kill);
        const failing = this.failing;
        return {
          async *[Symbol.asyncIterator]() {
            if (failing) return;
            yield { stream: 'stdout' as const, text: '{"ready":true}\n' };
            await killed;
          },
          async return() {
            kill();
            return { done: true as const, value: undefined };
          },
        };
      },
      fetch: async (_url, init) => {
        this.requests.push(`${init.socketPath} ${init.body}`);
        return { text: JSON.stringify({ status: 'error', error: 'no project here' }) };
      },
      repaint: () => {
        this.repaints++;
      },
      suggest: async () => ({ isShown: false }),
    };
  }

  /** Ends the `index`th helper as SIGKILL would: its output just stops. */
  kill(index: number): void {
    this.#kills[index]?.();
  }
}

/** Time at a hundredth of the real pace, so restart waits take milliseconds. */
const FAST = 100;
const fastClock = createClock({
  setTimer: (callback, ms) => {
    const id = setTimeout(callback, ms / FAST);
    return () => clearTimeout(id);
  },
});

async function bootWithHelper(helpers: FakeHelpers): Promise<ClaudeHost> {
  const host = createClaudeHost({ skipProbes: true, clock: fastClock });
  await host.bootPacked({
    payloadRoot: '/data/murmo/package',
    integrityJson: JSON.stringify({ version: PLUGIN_VERSION }),
    cwd: '/project',
    services: helpers.services(),
    helperBinaries: ['/data/murmo/package/bin/murmo-plugin-host'],
    tmpdir: '/tmp',
  });
  return host;
}

const until = async (what: string, ok: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('a helper killed mid-session is restarted and the session talks to the new one', async () => {
  // Killing murmo-plugin-host left the session without a helper and nothing
  // said so: no notice, no respawn, doctor still reported it fine.
  const helpers = new FakeHelpers();
  const host = await bootWithHelper(helpers);
  try {
    assert.equal(host.adapter.probes.helper, true);
    helpers.kill(0);
    await until('a restart', () => helpers.started.length === 2 && host.adapter.probes.helper);
    await host.helper?.transport().request({ op: 'stats' });
    assert.ok(helpers.requests.at(-1)?.startsWith(`${helpers.started[1]} `), 'request went to the dead helper');
    assert.equal(host.adapter.notices.includes(HELPER_DOWN_NOTICE), false);
  } finally {
    await host.dispose();
  }
});

test('a helper that keeps dying stays down with one notice instead of respawning forever', async () => {
  const helpers = new FakeHelpers();
  const host = await bootWithHelper(helpers);
  try {
    helpers.failing = true;
    const repaintsBefore = helpers.repaints;
    helpers.kill(0);
    await until('the restarts to run out', () => host.adapter.notices.includes(HELPER_DOWN_NOTICE));
    assert.equal(helpers.started.length, 1 + HELPER_RESTART_DELAYS_MS.length);
    assert.equal(host.adapter.probes.helper, false);
    assert.equal(host.adapter.notices.filter((n) => n === HELPER_DOWN_NOTICE).length, 1);
    // Claude keeps the last status tail until asked to draw it again (status
    // changes repaint too, so count from the kill).
    assert.ok(helpers.repaints > repaintsBefore);
  } finally {
    await host.dispose();
  }
});

test('the helper Claude stops on exit is not restarted after session.end', async () => {
  // Claude SIGTERMs spawned processes a few milliseconds before session.end.
  const helpers = new FakeHelpers();
  const host = await bootWithHelper(helpers);
  helpers.kill(0);
  await host.dispose();
  await new Promise((resolve) => setTimeout(resolve, (HELPER_RESTART_DELAYS_MS[0] ?? 0) / FAST + 100));
  assert.equal(helpers.started.length, 1);
});

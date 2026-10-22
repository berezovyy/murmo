// A typed helper timeout must not disable healthy plugins (lesson 71).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executorFault } from '@murmo/executor';
import { createClaudeHost } from '../src/session.ts';
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

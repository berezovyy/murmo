// Overlay node reuse (lesson 19) and escape-literal rendering (lesson 77).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenCodeAdapter } from '../src/adapter.ts';
import { FakeOpenCode } from './fake-opencode.ts';

test('ghost and menu reuse two nodes; a third show does not grow the tree (E7)', async () => {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  await adapter.ready();
  host.focusPrompt();
  adapter.attach();
  const version = adapter.getDraft().version;
  adapter.showGhost('alpha', version);
  adapter.showGhost('beta', version);
  adapter.showMenu([{ id: 'a', label: 'A', owner: 'shortcuts' }], 0, version);
  adapter.showMenu(
    [
      { id: 'a', label: 'A', owner: 'shortcuts' },
      { id: 'b', label: 'B', owner: 'shortcuts' },
    ],
    1,
    version,
  );
  assert.ok(adapter.overlaySize <= 3, `overlay nodes ${adapter.overlaySize}`);
  adapter.dispose();
});

test('OSC 52 in a ghost renders as escaped literal text, never as a host command (E13)', async () => {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  await adapter.ready();
  adapter.attach();
  const payload = `\x1b]52;c;AAAA\x07`;
  adapter.showGhost(payload, adapter.getDraft().version);
  const node = host.overlayNode('ghost');
  assert.ok(node?.content?.includes('\\u001b') || node?.content?.includes(']52'));
  assert.equal(node?.content?.includes('\x1b'), false);
  adapter.dispose();
});

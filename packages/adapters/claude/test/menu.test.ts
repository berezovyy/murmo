// Autocomplete rows, virtualText ghost, escape payloads stay literal (E8, E15).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayText } from '@murmo/text';
import { createClaudeHost } from '../src/session.ts';
import { boot, type } from './boot.ts';
import { autocompleteNext, FakeClaude, liveServices } from './fake-runtime.ts';

test('nativeCompletion rows come from inlineEdit menu items (E8)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, ';t');
  const version = host.adapter.getDraft().version;
  host.adapter.showMenu(
    [
      {
        owner: 'shortcuts',
        id: 'tst',
        label: ';tst',
        inlineEdit: { baseVersion: version, from: 0, to: 2, insert: 'tested', undoable: true },
      },
    ],
    0,
    version,
  );
  const event = { text: fake.draft.text, cursor: fake.draft.cursor, token: ';t', start: 0 };
  const rows = host.adapter.handleAutocomplete(event, autocompleteNext()(event));
  assert.equal(rows.suggestions[0]?.text, 'tested');
  await host.dispose();
});

test('a row validated for another span never replaces the token Claude completes', async () => {
  // The menu answers each key asynchronously, so the rows on hand can still be
  // the previous key's: taking one would replace `;tx` with what `;t` meant.
  const { fake, host } = await boot();
  await type(host, fake, ';tx');
  host.adapter.showMenu(
    [
      {
        owner: 'shortcuts',
        id: 'tst',
        label: ';tst',
        inlineEdit: { baseVersion: host.adapter.getDraft().version, from: 0, to: 2, insert: 'tested', undoable: true },
      },
    ],
    0,
    host.adapter.getDraft().version,
  );
  const event = { text: fake.draft.text, cursor: fake.draft.cursor, token: ';tx', start: 0 };
  assert.deepEqual(host.adapter.handleAutocomplete(event, autocompleteNext()(event)).suggestions, []);
  await host.dispose();
});

test('typing ; gives Claude completion rows from the configured shortcuts', async () => {
  // Typed keys reached the core as untyped resyncs, so the menu never saw a
  // typed `;` and Claude's list stayed empty on every host version.
  const fake = new FakeClaude();
  const host = createClaudeHost({ skipProbes: true });
  try {
    await host.bootPacked({
      payloadRoot: '',
      integrityJson: '{}',
      cwd: '/project',
      userToml: 'version = 1\n[replace]\n";hp" = "harness project shortcut"\n',
      services: liveServices(),
    });
    for (const [typed, token] of [
      [';', ';'],
      ['h', ';h'],
    ] as const) {
      await type(host, fake, typed);
      await new Promise((resolve) => setImmediate(resolve));
      const event = { text: fake.draft.text, cursor: fake.draft.cursor, token, start: 0 };
      const rows = host.adapter.handleAutocomplete(event, autocompleteNext()(event));
      assert.deepEqual(
        rows.suggestions.map((row) => [row.label, row.text]),
        [[';hp', 'harness project shortcut']],
        `after ${token}`,
      );
    }
  } finally {
    await host.dispose();
  }
});

test('ghost is a dim virtualText decoration at the cursor (E8)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, 'ab');
  host.adapter.showGhost('xyz', host.adapter.getDraft().version);
  const decorations = host.adapter.decorations();
  assert.equal(decorations[0]?.virtualText, 'xyz');
  assert.equal(decorations[0]?.dimColor, true);
  await host.dispose();
});

test('OSC 52 in status and menu labels render as literal displayText (E15, lesson 77)', async () => {
  const payload = '\u001b]52;c;AAAA\u0007';
  const shown = displayText(payload);
  assert.ok(shown.includes('\\u001b'));
  assert.equal(shown.includes('\u001b'), false);
  const { host } = await boot();
  host.adapter.showStatus(payload, host.adapter.getDraft().version);
  assert.ok(host.adapter.statusLine().includes('\\u001b'));
  await host.dispose();
});

// Autocomplete rows, virtualText ghost, escape payloads stay literal (E8, E15).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayText } from '@murmo/text';
import { boot, type } from './boot.ts';
import { autocompleteNext } from './fake-runtime.ts';

test('nativeCompletion rows come from inlineEdit menu items (E8)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, 'hello');
  const version = host.adapter.getDraft().version;
  host.adapter.showMenu(
    [
      {
        owner: 'shortcuts',
        id: 'tst',
        label: ';tst',
        inlineEdit: { baseVersion: version, from: 0, to: 5, insert: 'tested', undoable: true },
      },
    ],
    0,
    version,
  );
  const rows = host.adapter.handleAutocomplete(
    { text: fake.draft.text, cursor: fake.draft.cursor, token: ';t', start: 0 },
    autocompleteNext()({ text: fake.draft.text, cursor: fake.draft.cursor, token: ';t', start: 0 }),
  );
  assert.equal(rows.suggestions[0]?.text, 'tested');
  await host.dispose();
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

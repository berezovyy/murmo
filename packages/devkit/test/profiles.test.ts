// Profile packet with the inline table: teh/adn/recieve (E4). The three words
// are in the phase-12 88,525-entry table and in the test table.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness, testInlinePlugin } from '@murmo/core/testing';
import { FakeEditorSlot, type FakeHostProfile, ProfiledFakeAdapter } from '@murmo/fake-host';

const packet = [
  { origin: 'typed' as const, text: 'teh ' },
  { origin: 'paste' as const, text: 'recieve ' },
  { origin: 'typed' as const, text: 'adn ' },
];

const expected: Record<FakeHostProfile, string> = {
  claude: 'teh recieve adn ',
  codex: 'the recieve and ',
  opencode: 'the and recieve ',
  pi: 'the recieve and ',
};

async function packetText(profile: FakeHostProfile): Promise<string> {
  const slot = new FakeEditorSlot();
  const adapter = new ProfiledFakeAdapter(profile, { editorSlot: slot });
  const h = await createHarness({
    adapter,
    plugins: [testInlinePlugin('ac')],
    realtime: true,
  });
  try {
    adapter.packet(packet);
    await h.driver.settle();
    return adapter.getDraft().text;
  } finally {
    await h.session?.dispose();
    adapter.dispose();
  }
}

test('typed teh + pasted recieve + typed adn matches each measured host (E4)', async () => {
  for (const profile of ['claude', 'codex', 'opencode', 'pi'] as const) {
    assert.equal(await packetText(profile), expected[profile], profile);
  }
});

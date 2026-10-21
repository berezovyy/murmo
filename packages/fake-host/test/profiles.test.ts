// Packet order, Claude unknown bursts, Pi editor slot (E4, E5, lessons 64, 68, 78).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FakeEditorSlot,
  newestRecord,
  ProfiledFakeAdapter,
  profileEvidence,
  profileIsStale,
  SEED_RECORDS,
} from '../src/index.ts';

const packet = [
  { origin: 'typed' as const, text: 'teh ' },
  { origin: 'paste' as const, text: 'recieve ' },
  { origin: 'typed' as const, text: 'adn ' },
];

test('Claude bursts have unknown origin and 0 typed spans (lesson 64)', async () => {
  const adapter = new ProfiledFakeAdapter('claude');
  await adapter.ready();
  adapter.burst([{ origin: 'typed', text: 'teh ' }]);
  assert.equal(adapter.getDraft().text, 'teh ');
  assert.deepEqual(adapter.getDraft().typedSpans, []);
  assert.equal(
    (await adapter.applyEditIfVersion({ from: 0, to: 3, insert: 'the', baseVersion: 1 })).status,
    'unsupported',
  );
});

test('OpenCode delivers packet paste after following typed text (lesson 68)', async () => {
  const adapter = new ProfiledFakeAdapter('opencode');
  await adapter.ready();
  adapter.packet(packet);
  assert.equal(adapter.getDraft().text, 'teh adn recieve ');
});

test('Pi slot: second owner refused; replace denies our edit; dispose does not release the new owner (lesson 78)', async () => {
  const slot = new FakeEditorSlot();
  slot.acquire('first');
  assert.throws(() => slot.acquire('second'), /already owned by first/);
  const adapter = new ProfiledFakeAdapter('pi', { editorSlot: slot, owner: 'murmo' });
  // Slot still held by first; ready must fail to acquire.
  await assert.rejects(() => adapter.ready(), /already owned by first/);

  const free = new FakeEditorSlot();
  const ours = new ProfiledFakeAdapter('pi', { editorSlot: free, owner: 'murmo' });
  await ours.ready();
  assert.equal(free.current(), 'murmo');
  ours.fill('hello', 'unknown');
  const { displaced } = free.replace('peer');
  assert.equal(displaced, 'murmo');
  assert.equal(ours.getDraft().certainty, 'unknown');
  const denied = await ours.applyEditIfVersion({
    from: 0,
    to: 0,
    insert: 'x',
    baseVersion: ours.getDraft().version,
  });
  assert.equal(denied.status, 'denied');
  ours.dispose();
  assert.equal(free.current(), 'peer');
});

test('Codex Tab queues unless a native popup is showing (round-14 native-popup-Tab)', async () => {
  const adapter = new ProfiledFakeAdapter('codex');
  await adapter.ready();
  await adapter.type('hi');
  await adapter.key('Tab');
  assert.equal(adapter.requests.length, 1);
  assert.equal(adapter.requests[0]?.gesture, 'queue');
  adapter.fill('next', 'unknown');
  adapter.setState({ popup: { owner: 'host' } });
  await adapter.key('Tab');
  assert.equal(adapter.requests.length, 1);
  assert.equal(adapter.nativeKeys.at(-1), 'Tab');
});

test('OpenCode status lands in the footer slot (round-14)', async () => {
  const adapter = new ProfiledFakeAdapter('opencode');
  await adapter.ready();
  assert.equal(adapter.statusSlot, 'footer');
  const shown = adapter.showStatus('ok', adapter.getDraft().version);
  assert.equal(shown.status, 'applied');
  assert.equal(adapter.footer, 'ok');
});

test('seed JSON records match the embedded seeds and are not stale (profile generation)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../records');
  for (const host of ['claude', 'codex', 'opencode', 'pi'] as const) {
    const file = JSON.parse(readFileSync(join(dir, `${host}.json`), 'utf8')) as {
      host: string;
      version: string;
      historical: boolean;
    };
    const seed = newestRecord(host);
    assert.equal(file.host, host);
    assert.equal(file.version, seed.version);
    assert.equal(file.historical, true);
    assert.equal(profileEvidence[host].version, seed.version);
    assert.equal(profileIsStale(host, profileEvidence[host].version), false);
    assert.equal(SEED_RECORDS.filter((r) => r.host === host).length, 1);
  }
});

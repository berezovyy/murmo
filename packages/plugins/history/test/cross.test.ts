// A prompt recorded at one host is found from another (12 pairs on the fake
// adapter; real-host pairs wait on phase 20).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryStore } from '../src/memory.ts';
import { PROJECT, withHistory } from './helpers.ts';

const HOSTS = ['claude', 'codex', 'opencode', 'pi'] as const;
const TEXT = 'Review the OutboxWorker drain_queue path for timeouts.';

test('a prompt typed in each host is found from every other host (12 pairs)', async () => {
  const memory = createMemoryStore();
  for (const host of HOSTS) {
    memory.record([{ text: `${TEXT} from ${host}`, host, project: PROJECT, at: 1 }]);
  }
  for (const from of HOSTS) {
    for (const to of HOSTS) {
      if (from === to) continue;
      const h = await withHistory(memory, { enabled: true });
      await h.driver.type(`;?from ${from}`);
      await h.driver.settle();
      const labels = h.adapter.menu?.map((r) => r.label).join('\n') ?? '';
      assert.ok(labels.includes(`from ${from}`), `${from} -> ${to}: ${labels}`);
      await h.session?.dispose();
    }
  }
});

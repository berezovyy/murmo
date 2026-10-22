// Detect uses a throwaway HOME so OpenCode --version writes do not spoil uninstall (E2).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectHosts } from '../src/detect.ts';
import { makeHome, tree } from './helpers.ts';

test('detect finds fake hosts and leaves the target HOME unchanged', () => {
  const t = makeHome('murmo-detect-');
  try {
    const before = tree(t.home);
    const hosts = detectHosts(t.env);
    const byName = Object.fromEntries(hosts.map((h) => [h.name, h]));
    assert.equal(byName.pi?.installed, true);
    assert.equal(byName.opencode?.installed, true);
    assert.equal(byName.claude?.installed, true);
    assert.equal(byName.codex?.installed, true);
    assert.deepEqual(tree(t.home), before);
    assert.equal(existsSync(join(t.home, '.local', 'state', 'opencode')), false);
    assert.equal(existsSync(join(t.home, '.cache', 'opencode')), false);
  } finally {
    t.remove();
  }
});

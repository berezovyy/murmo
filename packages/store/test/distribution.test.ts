// Update journal: SIGKILL mid-update must leave the old or new generation
// selected, never a mix (plan 28 interrupted-update).
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  initPluginStore,
  readPluginsManifest,
  recoverInterrupted,
  writeJournal,
  writePluginsManifest,
} from '../src/node/distribution.ts';
import { tempRoots } from './helpers.ts';

test('recoverInterrupted undoes an extract that never selected the new digest', async () => {
  const home = tempRoots('murmo-dist-');
  try {
    const manifest = await initPluginStore(home.roots);
    await writePluginsManifest(home.roots, {
      ...manifest,
      plugins: {
        ...manifest.plugins,
        demo: {
          enabled: true,
          grants: [],
          distribution: {
            digest: 'a'.repeat(64),
            publisher: 'b'.repeat(64),
            manifest: { id: 'demo' },
            source: { kind: 'tarball', spec: 'demo.tgz' },
          },
        },
      },
    });
    const orphan = 'c'.repeat(64);
    mkdirSync(join(home.roots.data, 'extensions', 'demo', orphan), { recursive: true });
    await writeJournal(home.roots, {
      schema: 1,
      op: 'update',
      id: 'demo',
      phase: 'extract',
      toDigest: orphan,
      fromDigest: 'a'.repeat(64),
      previousEnabled: true,
    });
    assert.equal(await recoverInterrupted(home.roots), 'undone');
    const after = await readPluginsManifest(home.roots);
    assert.equal(after?.plugins.demo?.distribution?.digest, 'a'.repeat(64));
  } finally {
    home.remove();
  }
});

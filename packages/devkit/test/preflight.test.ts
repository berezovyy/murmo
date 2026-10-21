// Required capability missing is refused with 0 factory calls (E3, K1).
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ManifestError } from '@murmo/api';
import { ProfiledFakeAdapter } from '@murmo/fake-host';
import { preparePlugin } from '../src/loader.ts';
import { pluginNew } from '../src/plugin-new.ts';

test('a plugin that requires a capability the profile lacks is refused with 0 factory calls', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'murmo-pre-'));
  const dir = await pluginNew('needs-atomic', parent);
  const marker = join(parent, 'factory-ran');
  await writeFile(
    join(dir, 'plugin.mjs'),
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'ran');
export default () => ({ name: 'needs-atomic', version: '0.1.0', permissions: ['draft:read'] });
`,
  );
  await writeFile(
    join(dir, 'murmo.plugin.json'),
    JSON.stringify({
      name: 'needs-atomic',
      version: '0.1.0',
      api: '^2.0.0',
      entry: 'plugin.mjs',
      permissions: [{ name: 'draft:read', reason: 'read' }],
      capabilities: { required: { 'edit.atomic': true }, optional: {} },
      settingsSchema: { type: 'object', properties: {} },
    }),
  );
  const adapter = new ProfiledFakeAdapter('claude');
  await assert.rejects(
    () => preparePlugin(dir, { caps: adapter.caps }),
    (error: unknown) => error instanceof ManifestError && error.code === 'capability-unavailable',
  );
  await assert.rejects(() => import('node:fs/promises').then((fs) => fs.stat(marker)), /ENOENT/);
});

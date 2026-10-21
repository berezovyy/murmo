import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { copyPublicTypes } from './types-copy.ts';

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function pluginNew(name: string, parent = process.cwd()): Promise<string> {
  if (!NAME.test(name ?? '')) throw new Error('name must be 1–64 lowercase letters/digits/hyphens');
  const directory = resolve(parent, name);
  await mkdir(directory);
  try {
    const manifest = {
      name,
      version: '0.1.0',
      api: '^2.0.0',
      entry: 'plugin.mjs',
      permissions: [{ name: 'draft:read', reason: 'Count characters in the current draft.' }],
      capabilities: {
        required: { readDraft: true, status: true },
        optional: { 'api.typed-read-default': true },
      },
      settingsSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', default: true, description: 'Show the character count.' },
        },
        additionalProperties: false,
      },
    };
    await writeFile(resolve(directory, 'murmo.plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await copyPublicTypes(directory);
    await writeFile(
      resolve(directory, 'plugin.mjs'),
      `// @ts-check
/** @type {import('./murmo-api/index.js').PluginFactory} */
export default settings => ({
  name: ${JSON.stringify(name)},
  version: '0.1.0',
  permissions: ['draft:read'],
  onChange(change, ctx) {
    return [{
      type: 'status',
      text: settings?.enabled === false ? null : change.draft.text.length + ' chars',
      baseVersion: ctx.draft.version,
    }];
  },
});
`,
    );
    await writeFile(
      resolve(directory, 'plugin.test.mjs'),
      `export default async function ({ driver, assert }) {
  await driver.type('hello');
  assert.equal(driver.observe().status, '[plugin ${name}] 5 chars');
  assert.equal(driver.observe().requests.length, 0);
}
`,
    );
    await writeFile(
      resolve(directory, 'README.md'),
      `# ${name}

Draft 2.0-pre plugin. From this directory:

\`\`\`
murmo plugin test
murmo plugin test --profile claude
murmo plugin dev --profile codex
\`\`\`

The module is self-contained and runs in QuickJS and \`murmo-plugin-host\`. Keep
imports out of \`plugin.mjs\`; \`murmo-api/\` is for editor type-checking only.
Manifest permissions describe requests, not grants.

A passing fake-host test is not a real-agent pass: profiles do not model
frames, IME, native undo, attachments, or 2.0-pre gaps of stock adapters
(no host-labeled origin on every host, no \`dialogSafe\`, no attribution).

Run someone else's plugin and tests only inside a \`--network none\` container.

Dev commands: type TEXT, paste TEXT, burst TEXT, key KEY, packet JSON, state JSON,
submit, timeline, quit. Profiles: fake|claude|codex|opencode|pi.
`,
    );
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

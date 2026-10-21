// Scaffold writes a complete plugin and refuses to clobber or follow an
// escaping entry symlink (E3, K1).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeAdapter } from '@murmo/fake-host';
import { preparePlugin } from '../src/loader.ts';
import { pluginNew } from '../src/plugin-new.ts';

test('new refuses an existing folder and a name that is not a plugin id', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'murmo-new-'));
  await pluginNew('ok-plugin', parent);
  await assert.rejects(() => pluginNew('ok-plugin', parent), /already exists|EEXIST/i);
  await assert.rejects(() => pluginNew('Nope', parent), /lowercase/);
});

test('new writes manifest, self-contained module, types, test and README', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'murmo-new-'));
  const dir = await pluginNew('hello', parent);
  const manifest = JSON.parse(await readFile(join(dir, 'murmo.plugin.json'), 'utf8')) as { api: string; name: string };
  assert.equal(manifest.name, 'hello');
  assert.equal(manifest.api, '^2.0.0');
  const plugin = await readFile(join(dir, 'plugin.mjs'), 'utf8');
  assert.match(plugin, /onChange/);
  assert.doesNotMatch(plugin, /from ['"]node:/);
  await readFile(join(dir, 'murmo-api/index.d.ts'), 'utf8');
  await readFile(join(dir, 'plugin.test.mjs'), 'utf8');
  await readFile(join(dir, 'README.md'), 'utf8');
});

test('preparePlugin refuses an entry symlink that escapes the package', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'murmo-esc-'));
  const dir = await pluginNew('trap', parent);
  const outside = join(parent, 'outside.mjs');
  await writeFile(outside, 'export default () => ({ name: "x", version: "1", permissions: [] });\n');
  await mkdir(join(dir, 'tmp'), { recursive: true });
  const link = join(dir, 'plugin.mjs');
  const { unlink } = await import('node:fs/promises');
  await unlink(link);
  await symlink(outside, link);
  await assert.rejects(() => preparePlugin(dir, { caps: new FakeAdapter().caps }), /escapes/);
});

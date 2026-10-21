// The examples are the author surface in use: the four shared samples, the
// sample menu and the four r14 author plugins, ported to 2.0. `pnpm check`
// compiles them; these tests hold what the compiler can't see.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isCanonicalKey, type PluginFactory, parseManifest, resolveSettings } from '../src/index.ts';

const examples = fileURLToPath(new URL('../examples/', import.meta.url));
const names = readdirSync(examples, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

test('every sample, example and author port is present (E25)', () => {
  assert.deepEqual(names, [
    'autocorrect',
    'branch-context',
    'file-picker',
    'prompt-lint',
    'sample-menu',
    'semicolon-menu',
    'status-counter',
    'todo-guard',
    'token-meter',
  ]);
});

for (const name of names) {
  const dir = join(examples, name);
  const source = readFileSync(join(dir, 'plugin.ts'), 'utf8');

  test(`${name}: imports only types from @murmo/api, so it compiles without the adapter entry point and bundles to a self-contained module (E25)`, () => {
    const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)];
    assert.ok(imports.length > 0, 'no import found: the example would not be checked against @murmo/api');
    for (const [statement, typeOnly, specifier] of imports) {
      assert.equal(specifier, '@murmo/api', statement);
      assert.ok(typeOnly, `${statement}: a runtime import would make the isolated source depend on a bundler`);
    }
  });

  test(`${name}: its manifest passes preflight and matches the plugin, which the core requires before loading (r14 K1)`, async () => {
    const manifest = parseManifest(readFileSync(join(dir, 'murmo.plugin.json'), 'utf8'));
    const factory: PluginFactory = (await import(join(dir, 'plugin.ts'))).default;
    const plugin = factory(resolveSettings(manifest));
    assert.equal(plugin.name, manifest.name);
    assert.equal(plugin.version, manifest.version);
    const declared = new Set(manifest.permissions.map((p) => p.name));
    for (const permission of plugin.permissions) assert.ok(declared.has(permission), `${permission} is not declared`);
    for (const claim of plugin.keys ?? []) assert.ok(isCanonicalKey(claim.key), `${claim.key} is not a canonical key`);
  });
}

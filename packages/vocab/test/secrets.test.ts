// After building a synthetic repo, the cache holds 0 bytes from .env, key
// files or string literals, and no declaration lines: the path filter and the
// string-skipping extractor keep them out (architecture rule; Prompt Line
// cached API_KEY lines).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildAndWrite } from '../src/node/build.ts';
import { englishTable, gitRepo, tempDir } from './helpers.ts';

const SECRET_LINE = 'API_KEY=sk-live-not-a-real-secret-value-0123456789';
const STRING_LIT = 'wJalc6d8exampleSecretAccessKeyValueXX';
const ENV_BODY = `${SECRET_LINE}\n`;
const KEY_BODY = '-----BEGIN PRIVATE KEY-----\nMIIEexample\n-----END PRIVATE KEY-----\n';

test('synthetic repo: cache has no key-file or .env bytes, string literals or declaration lines', async () => {
  const t = tempDir('murmo-vocab-secret-');
  after(() => t.remove());
  gitRepo(t.dir, {
    '.env': ENV_BODY,
    'tls.key': KEY_BODY,
    'secret-token.txt': SECRET_LINE,
    'package-lock.json': '{"lockfileVersion": 3}',
    'node_modules/evil/index.js': `export const x = "${STRING_LIT}";`,
    'vendor/lib.rs': `pub const K: &str = "${STRING_LIT}";`,
    'src/lib.rs': `fn ser() {}\nconst LINE: &str = "${STRING_LIT}";\n`,
    'package.json': '{"name":"demo","dependencies":{"ser":"1"}}',
  });
  const { table, hash } = englishTable();
  const cacheDir = join(t.dir, 'cache');
  await buildAndWrite({ root: t.dir, cacheDir, typo: table, typoHash: hash });
  const blobs: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else blobs.push(readFileSync(path, 'utf8'));
    }
  };
  walk(cacheDir);
  const all = blobs.join('\n');
  assert.equal(all.includes(SECRET_LINE), false);
  assert.equal(all.includes(STRING_LIT), false);
  assert.equal(all.includes(KEY_BODY.slice(0, 20)), false);
  assert.equal(all.includes('const LINE'), false);
  assert.equal(all.includes(ENV_BODY.trim()), false);
});

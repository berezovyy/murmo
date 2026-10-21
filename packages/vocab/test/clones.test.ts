// Size/speed targets on the r6 clones when they are readable (read-only).
// Opt-in: MURMO_VOCAB_CLONES=1. Linux offline image only mounts the worktree.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FILE_CACHE_DIR } from '../src/index.ts';
import { buildProtection } from '../src/node/build.ts';
import { saveFileCache } from '../src/node/cache.ts';
import { englishTable, tempDir } from './helpers.ts';

const clones: Record<string, string> = {
  codex: '/Users/berezovyy/Projects/murmo/experiments/codex',
  opencode: '/Users/berezovyy/Projects/murmo/experiments/opencode',
  pi: '/Users/berezovyy/Projects/murmo/experiments/pi',
  typos: '/Users/berezovyy/Projects/murmo/experiments/typo-list',
};

const enabled = process.env.MURMO_VOCAB_CLONES === '1';

function present(): [string, string][] {
  return Object.entries(clones).filter(([, path]) => existsSync(path));
}

test('protection tables on the r6 clones stay ≤ 64 KiB (target)', { skip: !enabled || present().length === 0 }, () => {
  const { table, hash } = englishTable();
  const t = tempDir('murmo-vocab-clones-');
  after(() => t.remove());
  for (const [name, root] of present()) {
    const result = buildProtection({ root, cacheDir: join(t.dir, name), typo: table, typoHash: hash });
    assert.ok(
      result.bytes.byteLength <= 64 * 1024,
      `${name} protection table ${result.bytes.byteLength} bytes (target 64 KiB)`,
    );
  }
});

test('Codex full rebuild ≤ 3 s (target; r6 2.78 s p50)', {
  skip: !enabled || !existsSync(clones.codex as string),
}, () => {
  const { table, hash } = englishTable();
  const t = tempDir('murmo-vocab-codex-');
  after(() => t.remove());
  const cacheDir = join(t.dir, 'cache');
  const start = performance.now();
  const result = buildProtection({
    root: clones.codex as string,
    cacheDir,
    typo: table,
    typoHash: hash,
  });
  const ms = performance.now() - start;
  assert.ok(ms <= 3000, `Codex full rebuild ${ms.toFixed(0)} ms (target 3000)`);
  mkdirSync(join(cacheDir, FILE_CACHE_DIR), { recursive: true });
  saveFileCache(cacheDir, result.cache);
  const warm = performance.now();
  const again = buildProtection({
    root: clones.codex as string,
    cacheDir,
    typo: table,
    typoHash: hash,
  });
  const warmMs = performance.now() - warm;
  assert.ok(again.reused > 0, 'cached signatures must reuse files');
  assert.ok(warmMs <= 3000, `Codex cached rebuild ${warmMs.toFixed(0)} ms`);
  assert.equal(result.cacheKey, again.cacheKey);
});

// The scan must catch a planted key anywhere and ignore a regex source that
// names only the header (E22).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { scanBytes, scanTree } from '../src/scan.ts';

const root = mkdtempSync(join(tmpdir(), 'murmo-scan-'));
after(() => rmSync(root, { recursive: true, force: true }));

const plantedPem = `-----${'BEGIN'} PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----${'END'} PRIVATE KEY-----\n`;

test('a PEM private key anywhere under the tree is a hit; a header-only regex source is not', () => {
  const planted = join(root, 'packages', 'pack', 'evil.ts');
  mkdirSync(join(root, 'packages', 'pack'), { recursive: true });
  writeFileSync(planted, plantedPem);
  const hits = scanTree(join(root, 'packages'), root);
  assert.equal(hits.length, 1);
  assert.match(hits[0]?.path ?? '', /evil\.ts$/);
  assert.equal(scanBytes(`-----${'BEGIN'} PRIVATE KEY-----`, 'packages/pack/regex.ts'), undefined);
});

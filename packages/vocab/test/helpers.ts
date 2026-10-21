import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mapTable, type PackedTable } from '@murmo/lang';
import { ensurePack, PACK_FILES } from '@murmo/lang-en';
import type { StoreRoots } from '@murmo/store';

export function tempDir(prefix: string): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

/** Real git repo so `git ls-files` is the tracked listing. */
export function gitRepo(root: string, files: Readonly<Record<string, string>>): void {
  writeTree(root, files);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync(
    'git',
    ['-c', 'user.email=murmo@test', '-c', 'user.name=murmo', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'],
    { cwd: root, stdio: 'ignore' },
  );
}

export function tempStore(prefix: string): { dir: string; roots: StoreRoots; remove: () => void } {
  const t = tempDir(prefix);
  return {
    dir: t.dir,
    roots: {
      data: join(t.dir, 'data', 'murmo'),
      state: join(t.dir, 'state', 'murmo'),
      cache: join(t.dir, 'cache', 'murmo'),
    },
    remove: t.remove,
  };
}

let packed: { table: PackedTable; hash: string; bytes: Uint8Array } | undefined;

export function englishTable(): { table: PackedTable; hash: string; bytes: Uint8Array } {
  if (packed) return packed;
  const dir = ensurePack();
  const raw = readFileSync(join(dir, PACK_FILES.table));
  const bytes = new Uint8Array(raw.byteLength);
  bytes.set(raw);
  packed = {
    table: mapTable(bytes),
    hash: createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
  return packed;
}

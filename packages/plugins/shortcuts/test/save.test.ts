// `murmo shortcuts save` writes the personal file only on an explicit y (E13, E14).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveCommand } from '../src/node/save.ts';
import type { TrustContext } from '../src/node/trust.ts';
import { gitRepo, tempDir } from './helpers.ts';

function ctx(home: string, cwd: string, ask?: (q: string) => Promise<string>) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    ctx: {
      store: {} as TrustContext['store'],
      cwd,
      out: (t: string) => out.push(t),
      err: (t: string) => err.push(t),
      env: { HOME: home },
      home,
      ...(ask ? { ask } : {}),
    } as TrustContext,
  };
}

test('without y the command prints a snippet and writes 0 bytes', async () => {
  const t = tempDir('murmo-save-n-');
  try {
    const home = t.dir;
    const io = ctx(home, home, async () => 'n');
    const code = await saveCommand(['--name', ';rv', '--text', 'Review this.'], io.ctx);
    assert.equal(code, 0);
    assert.match(io.out.join('\n'), /\[replace\]/);
    assert.match(io.out.join('\n'), /Not written/);
    try {
      readFileSync(join(home, '.config', 'murmo', 'murmo.toml'), 'utf8');
      assert.fail('wrote without y');
    } catch {
      // no file
    }
  } finally {
    t.remove();
  }
});

test('an explicit y appends to the personal file and never touches the project file', async () => {
  const t = tempDir('murmo-save-y-');
  try {
    const home = t.dir;
    const repo = gitRepo(home, { '.murmo.toml': 'version = 1\n[replace]\n";keep" = \'stay\'\n' });
    mkdirSync(join(home, '.config', 'murmo'), { recursive: true });
    const personal = join(home, '.config', 'murmo', 'murmo.toml');
    const before = 'version = 1\n[replace]\n";old" = \'prior\'\n';
    writeFileSync(personal, before);
    const project = join(repo, '.murmo.toml');
    const projectBefore = readFileSync(project, 'utf8');
    const io = ctx(home, repo, async () => 'y');
    const code = await saveCommand(['--name', ';rv', '--text', 'Review this.'], io.ctx);
    assert.equal(code, 0);
    const after = readFileSync(personal, 'utf8');
    assert.equal(after.slice(0, before.length), before);
    assert.match(after.slice(before.length), /";rv"/);
    assert.match(after.slice(before.length), /Review this/);
    assert.equal(readFileSync(project, 'utf8'), projectBefore);
  } finally {
    t.remove();
  }
});

test('--yes is an explicit confirmation and the file loads again', async () => {
  const t = tempDir('murmo-save-yes-');
  try {
    const home = t.dir;
    const io = ctx(home, home);
    const code = await saveCommand(['--name', ';n', '--text', 'Hello', '--yes'], io.ctx);
    assert.equal(code, 0);
    const path = join(home, '.config', 'murmo', 'murmo.toml');
    const body = readFileSync(path, 'utf8');
    assert.match(body, /version = 1/);
    assert.match(body, /Hello/);
  } finally {
    t.remove();
  }
});

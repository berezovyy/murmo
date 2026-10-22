// Catches packed adapters that only walked import.meta.url and missed the
// setup payload at $XDG_DATA_HOME/murmo/package/data/en/english.bin.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeTable } from '@murmo/lang';
import { findShippedEnglishDir } from '../src/node/from-dir.ts';

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    prev[key] = process.env[key];
    const next = values[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('findShippedEnglishDir uses the installed payload when MURMO_PACKAGE_ROOT is unset', () => {
  const root = mkdtempSync(join(tmpdir(), 'murmo-from-dir-'));
  try {
    const data = join(root, '.local', 'share');
    mkdirSync(join(data, 'murmo', 'package', 'data', 'en'), { recursive: true });
    writeFileSync(join(data, 'murmo', 'package', 'data', 'en', 'english.bin'), encodeTable([['teh', 'the']]));
    withEnv(
      {
        MURMO_PACKAGE_ROOT: undefined,
        XDG_DATA_HOME: data,
        HOME: root,
      },
      () => {
        assert.equal(findShippedEnglishDir(join(root, 'nowhere')), join(data, 'murmo', 'package', 'data', 'en'));
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Bun's built-in TOML parser stays out of the codebase (phase 14, lesson 27):
// it reports the JavaScript call site instead of the TOML line and returns
// different values for CRLF files than smol-toml and Rust do (r8 § 53).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const biome = join(repo, 'node_modules', '.bin', 'biome');

/** Lints one probe file in this folder (Biome only reads files inside the project) and returns its diagnostics. */
function lint(code: string): string {
  const probe = join(repo, 'packages', 'config', 'test', `lint-probe-${randomBytes(6).toString('hex')}.ts`);
  writeFileSync(probe, code);
  try {
    const run = spawnSync(biome, ['lint', '--max-diagnostics=50', probe], { cwd: repo, encoding: 'utf8' });
    if (run.error) throw run.error;
    return run.stdout + run.stderr;
  } finally {
    rmSync(probe, { force: true });
  }
}

test('every way of reaching Bun.TOML fails lint', () => {
  // Catches a host adapter that parses config with Bun's TOML (call-site lines, CRLF drift).
  const forms = {
    member: 'export const parse = (t: string) => Bun.TOML.parse(t);\n',
    computed: 'export const parse = (t: string) => Bun["TOML"].parse(t);\n',
    named: "import { TOML } from 'bun';\nexport const parse = (t: string) => TOML.parse(t);\n",
    file: "import config from './murmo.toml';\nexport { config };\n",
  };
  for (const [name, code] of Object.entries(forms)) {
    assert.match(lint(code), /Bun's built-in TOML parser/, `${name}: no Bun TOML diagnostic`);
  }
});

test('reading TOML through @murmo/config passes the same lint', () => {
  // Catches the rule firing on every mention of TOML, which would get it switched off.
  const output = lint("import { parseConfig } from '../src/index.ts';\nexport const TOML = parseConfig;\n");
  assert.doesNotMatch(output, /Bun's built-in TOML parser/);
});

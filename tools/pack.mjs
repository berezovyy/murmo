#!/usr/bin/env node
// One command that turns the monorepo into the signed npm tarball (phase 26).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = spawnSync(process.execPath, [join(root, 'packages/pack/src/cli.ts'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
process.exitCode = run.status ?? 1;

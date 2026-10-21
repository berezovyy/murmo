// Locate (and if needed build) murmo-plugin-host from the shared cargo target.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'Cargo.toml')) && existsSync(join(dir, 'packages/plugin-host'))) return dir;
    dir = dirname(dir);
  }
  return join(here, '../../../..');
}

function cargoTargetDir(root: string): string {
  if (process.env.CARGO_TARGET_DIR) return process.env.CARGO_TARGET_DIR;
  const run = spawnSync(process.execPath, [join(root, 'tools/cargo.mjs'), '--print-target-dir'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(run.stderr || 'cargo --print-target-dir failed');
  return run.stdout.trim();
}

/** Path of the debug helper binary, building it with the shared target dir if missing. */
export function helperBinary(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.MURMO_PLUGIN_HOST) return process.env.MURMO_PLUGIN_HOST;
  const root = repoRoot();
  const debug = join(cargoTargetDir(root), 'debug', 'murmo-plugin-host');
  const release = join(cargoTargetDir(root), 'release', 'murmo-plugin-host');
  if (existsSync(debug)) return debug;
  if (existsSync(release)) return release;
  const run = spawnSync(
    process.execPath,
    [join(root, 'tools/cargo.mjs'), 'build', '--quiet', '--offline', '--locked', '-p', 'murmo-plugin-host'],
    { cwd: root, encoding: 'utf8' },
  );
  if (run.status !== 0) {
    throw new Error(`failed to build murmo-plugin-host: ${run.stderr || run.stdout}`);
  }
  if (!existsSync(debug)) throw new Error(`murmo-plugin-host missing at ${debug}`);
  return debug;
}

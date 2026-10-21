// Runs cargo with the shared target folder from AGENTS.md: every checkout and
// worktree of this repo builds into one CARGO_TARGET_DIR, never its own target/.
// Per-round target folders once filled about 150 GB.
//
//   node tools/cargo.mjs build --release        any cargo arguments
//   node tools/cargo.mjs --print-target-dir     where builds go
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { root } from './workspace.mjs';

/** The main checkout: the parent of git's common dir, shared by all worktrees. */
export function mainCheckout(cwd = root) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim();
    return dirname(isAbsolute(common) ? common : resolve(cwd, common));
  } catch {
    return cwd;
  }
}

export function targetDir({ env = process.env, cwd = root } = {}) {
  if (env.CARGO_TARGET_DIR) return env.CARGO_TARGET_DIR;
  return join(mainCheckout(cwd), 'experiments', '.cache', 'cargo-target', 'murmo');
}

/** cargo from PATH, else the rustup default location. */
export function cargoBinary(env = process.env) {
  const fromHome = join(env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin', 'cargo');
  const onPath = spawnSync('cargo', ['--version'], { stdio: 'ignore', env }).status === 0;
  return onPath ? 'cargo' : existsSync(fromHome) ? fromHome : 'cargo';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === '--print-target-dir') {
    console.log(targetDir());
  } else {
    const cargo = cargoBinary();
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, CARGO_TARGET_DIR: targetDir() };
    if (cargo !== 'cargo') env.PATH = `${dirname(cargo)}:${env.PATH}`;
    const run = spawnSync(cargo, args, { cwd: root, env, stdio: 'inherit' });
    process.exitCode = run.status ?? 1;
  }
}

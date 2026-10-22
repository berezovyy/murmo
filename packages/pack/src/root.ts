import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const repoRoot = dirname(dirname(packDir));

export function gitCommit(cwd = repoRoot): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function gitEpoch(cwd = repoRoot): string {
  try {
    return execFileSync('git', ['log', '-1', '--format=%ct'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '0';
  }
}

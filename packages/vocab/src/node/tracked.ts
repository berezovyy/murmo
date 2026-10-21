// Tracked paths: `git ls-files -z`, with a bounded walk when there is no git
// (docs/plan/19). Symlinks and non-regular files are skipped at lstat time.

import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { MAX_TRACKED_FILES, pathAllowed } from '../index.ts';

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export interface TrackedListing {
  readonly paths: readonly string[];
  /** SHA-256 of the NUL-separated listing; part of the cache key. */
  readonly hash: string;
  readonly via: 'git' | 'walk';
  readonly truncated: boolean;
}

function posix(rel: string): string {
  return rel.split(sep).join('/');
}

function gitList(root: string): string[] | undefined {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .toString('utf8')
      .split('\0')
      .filter((path) => path.length > 0);
  } catch {
    return undefined;
  }
}

function walkList(root: string, limit: number): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  const stack = [root];
  let truncated = false;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const rel = posix(relative(root, full));
        if (!pathAllowed(rel)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (paths.length >= limit) {
            truncated = true;
            continue;
          }
          stack.push(full);
          continue;
        }
        if (entry.isFile()) {
          if (paths.length >= limit) {
            truncated = true;
            continue;
          }
          paths.push(rel);
        }
      }
    } catch {
      // Unreadable directory: skip.
    }
  }
  return { paths, truncated };
}

export function listTracked(
  root: string,
  hashHex: (bytes: Uint8Array) => string,
  limit = MAX_TRACKED_FILES,
): TrackedListing {
  const git = gitList(root);
  let paths: string[];
  let via: 'git' | 'walk';
  let truncated: boolean;
  if (git) {
    via = 'git';
    const allowed = git.filter(pathAllowed);
    truncated = allowed.length > limit;
    paths = allowed.slice(0, limit);
  } else {
    via = 'walk';
    const walked = walkList(root, limit);
    paths = walked.paths;
    truncated = walked.truncated;
  }
  const joined = `${paths.join('\0')}\0`;
  const bytes = new Uint8Array(Buffer.from(joined, 'utf8'));
  return { paths, hash: hashHex(bytes), via, truncated };
}

/** lstat; undefined on missing. Never follows a symlink. */
export function lstatFile(path: string): { size: number; mtimeMs: number; ino: string; regular: boolean } | undefined {
  try {
    const st = lstatSync(path);
    return { size: st.size, mtimeMs: st.mtimeMs, ino: String(st.ino), regular: st.isFile() && !st.isSymbolicLink() };
  } catch {
    return undefined;
  }
}

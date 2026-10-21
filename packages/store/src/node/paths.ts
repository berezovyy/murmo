// Where the three roots are, and what a project is. A project is its
// canonical repository root: `projectId = sha256(realpath(root))`, with the
// device and inode kept apart from the display path, so a symlinked checkout
// is not a second project (Grammar Guard keyed on the absolute path, knowledge
// § 6, § 7). A git worktree is its own project.
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { StoreRoots } from '../layout.ts';
import { errorCode } from './files.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** An XDG variable counts only when it is an absolute path (XDG Base Directory spec). */
function xdg(env: Env, name: string, fallback: string): string {
  const value = env[name];
  return value && isAbsolute(value) ? value : fallback;
}

export function storeRootsFromEnv(env: Env = process.env, home: string = env.HOME || homedir()): StoreRoots {
  return {
    data: join(xdg(env, 'XDG_DATA_HOME', join(home, '.local', 'share')), 'murmo'),
    state: join(xdg(env, 'XDG_STATE_HOME', join(home, '.local', 'state')), 'murmo'),
    cache: join(xdg(env, 'XDG_CACHE_HOME', join(home, '.cache')), 'murmo'),
  };
}

export interface ProjectIdentity {
  /** sha256(realpath(root)), hex. */
  readonly projectId: string;
  /** Canonical root. */
  readonly root: string;
  /** Device and inode of the root, decimal. */
  readonly dev: string;
  readonly ino: string;
}

/** The first directory at or above `start` that holds `.git` (a folder, or a worktree's file), or undefined. */
export async function findRepositoryRoot(start: string): Promise<string | undefined> {
  let dir = await fsp.realpath(start);
  for (;;) {
    try {
      await fsp.lstat(join(dir, '.git'));
      return dir;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function projectIdOf(canonicalRoot: string): string {
  return createHash('sha256').update(canonicalRoot, 'utf8').digest('hex');
}

export async function projectIdentity(root: string): Promise<ProjectIdentity> {
  const canonical = await fsp.realpath(root);
  const st = await fsp.stat(canonical, { bigint: true });
  if (!st.isDirectory()) throw new Error(`${canonical} is not a directory`);
  return { projectId: projectIdOf(canonical), root: canonical, dev: String(st.dev), ino: String(st.ino) };
}

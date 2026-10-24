// `murmo init` / `murmo init --user`: write a starter file, never overwrite.
// `murmo setup` writes the personal one too, so a first session has shortcuts.
// The project file is approved because its bytes are Murmo's template; any
// later edit needs `murmo trust` like any other change.
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { approveProject, PROJECT_FILE, scanProject, userConfigPath } from '@murmo/config/node';
import { findRepositoryRoot } from '@murmo/store/node';
import { displayText } from '@murmo/text';
import { INIT_TEMPLATE, USER_TEMPLATE } from '../template.ts';
import type { TrustContext } from './trust.ts';

export const INIT_USAGE = 'usage: murmo init [--user]';

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes the starter personal file unless one exists (or is a symlink, even a
 * broken one): never overwrites, also when two writers race. True when written.
 */
export async function writeUserStarter(path: string): Promise<boolean> {
  if (await exists(path)) return false;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, USER_TEMPLATE, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export async function initCommand(args: readonly string[], context: TrustContext): Promise<number> {
  const user = args.includes('--user');
  if (args.some((a) => a !== '--user') || args.filter((a) => a === '--user').length > 1) {
    context.err(INIT_USAGE);
    return 2;
  }
  try {
    if (user) {
      const path = userConfigPath(context.env ?? process.env, context.home);
      if (!(await writeUserStarter(path))) {
        context.err(`${displayText(path)} already exists; not overwritten`);
        return 1;
      }
      context.out(`Wrote ${displayText(path)}.`);
      return 0;
    }
    const root = await findRepositoryRoot(context.cwd);
    if (!root) {
      context.err('no git repository here; run murmo init at a repository root, or murmo init --user');
      return 1;
    }
    const path = join(root, PROJECT_FILE);
    if (await exists(path)) {
      context.err(`${displayText(path)} already exists; not overwritten`);
      return 1;
    }
    await writeFile(path, INIT_TEMPLATE, { encoding: 'utf8', mode: 0o600 });
    const snapshot = await scanProject(root);
    if (!snapshot?.fingerprint) {
      context.err(`wrote ${displayText(path)} but could not approve it; run murmo trust`);
      return 1;
    }
    const result = await approveProject(context.store, root, snapshot.fingerprint, context.now?.() ?? Date.now());
    if (result.status !== 'ok') {
      context.err(`wrote ${displayText(path)} but approval failed (${result.status}); run murmo trust`);
      return 1;
    }
    context.out(`Wrote and approved ${displayText(path)}.`);
    return 0;
  } catch (error) {
    context.err(`murmo init: ${displayText((error as Error).message)}`);
    return 1;
  }
}

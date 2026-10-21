// Shared by the store tests and tools/store-parity.mjs: throwaway roots,
// writer processes and a file-tree walk.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoreRoots } from '../src/layout.ts';

export const childScript = fileURLToPath(new URL('./child.ts', import.meta.url));

export interface TempRoots {
  readonly dir: string;
  readonly roots: StoreRoots;
  remove(): void;
}

/** `<dir>/data/murmo`, `<dir>/state/murmo`, `<dir>/cache/murmo`, created lazily by the store. */
export function tempRoots(prefix = 'murmo-store-'): TempRoots {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    roots: { data: join(dir, 'data', 'murmo'), state: join(dir, 'state', 'murmo'), cache: join(dir, 'cache', 'murmo') },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const rootArgs = (roots: StoreRoots): string[] => [roots.data, roots.state, roots.cache];

/** Starts a writer process: the JS child, or any command (the Rust store-tool). */
export function startWriter(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

export function startChild(roots: StoreRoots, ...args: string[]): ChildProcess {
  return startWriter(process.execPath, [childScript, ...rootArgs(roots), ...args]);
}

/** Resolves once the process prints "ready" (its first write is on disk). */
export function whenReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('ready')) resolve();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once('exit', (code, signal) => reject(new Error(`writer exited (${code ?? signal}) before ready: ${err}`)));
  });
}

/** Waits for the process to end and returns its exit code (or signal) and stderr. */
export function finished(child: ChildProcess): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode, stderr });
      return;
    }
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

/** SIGKILLs the process and waits until it is gone, so its PID reads as dead. */
export async function kill(child: ChildProcess): Promise<void> {
  const done = finished(child);
  child.kill('SIGKILL');
  await done;
}

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TreeEntry {
  readonly path: string;
  readonly dir: boolean;
  readonly mode: number;
  readonly bytes?: Buffer;
}

/** Every directory and file under `root` (not following symlinks), with modes and contents. */
export function tree(root: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const visit = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const path = join(dir, name);
      const st = statSync(path, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) {
        out.push({ path, dir: true, mode: st.mode & 0o777 });
        visit(path);
      } else out.push({ path, dir: false, mode: st.mode & 0o777, bytes: readFileSync(path) });
    }
  };
  visit(root);
  return out;
}

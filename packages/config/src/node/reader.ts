// The bounded, no-follow reader for project files (port of r8
// `loader/files.mjs` `readInside`, same discipline as the r12 K2 broker).
// Every check that can refuse a path runs before the file is opened, so an
// escaping path, a FIFO or an oversized file is never opened at all; the bytes
// that are hashed are the bytes that load (lesson 27).
//
// Not proof against a hostile concurrent rename of a parent folder (r8 § 54,
// r12 K2): that needs a handle-rooted `openat` reader, proposed for the Rust
// helper in phase 10.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { type ReferenceProblem, referencePathProblem, type SymlinkHop } from '../index.ts';

export type InsideRead =
  | {
      readonly status: 'ok';
      readonly text: string;
      readonly bytes: number;
      readonly sha256: string;
      /** Repository-relative path after resolving symlinks. */
      readonly resolved: string;
      readonly links: readonly SymlinkHop[];
    }
  | { readonly status: 'refused'; readonly problem: ReferenceProblem };

/** Remaining read allowance of one load (r12 K2: 1 MiB and 128 reads per session). */
export interface ReadBudget {
  bytes: number;
  reads: number;
}

const refused = (problem: ReferenceProblem): InsideRead => ({ status: 'refused', problem });

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Reads `input` (relative, `/`-separated) inside the canonical `root`, at most
 * `maxBytes`. Symlinks inside the repository are followed and recorded;
 * anything that leaves it is refused.
 */
export async function readInside(
  root: string,
  input: string,
  maxBytes: number,
  budget?: ReadBudget,
): Promise<InsideRead> {
  const lexicalProblem = referencePathProblem(input);
  if (lexicalProblem) return refused(lexicalProblem);
  if (budget && (budget.reads <= 0 || budget.bytes <= 0)) return refused('budget');
  if (budget) budget.reads--;
  try {
    const links: SymlinkHop[] = [];
    let component = root;
    for (const part of input.split('/')) {
      if (part === '' || part === '.') continue;
      component = join(component, part);
      const st = await fsp.lstat(component);
      if (st.isSymbolicLink()) {
        const target = decoder.decode(await fsp.readlink(component, { encoding: 'buffer' }));
        links.push({ path: relative(root, component), target });
        if (!inside(root, await fsp.realpath(component))) return refused('escapes');
      }
    }
    const resolved = await fsp.realpath(component);
    if (!inside(root, resolved)) return refused('escapes');
    const before = await fsp.stat(resolved, { bigint: true });
    if (!before.isFile()) return refused('not-regular');
    if (before.size > BigInt(maxBytes)) return refused('too-large');
    if (budget && before.size > BigInt(budget.bytes)) return refused('budget');

    const handle = await fsp.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return refused('changed');
      const buffer = new Uint8Array(maxBytes + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      if (used > maxBytes) return refused('too-large');
      const after = await handle.stat({ bigint: true });
      if (
        BigInt(used) !== opened.size ||
        after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs ||
        (await fsp.realpath(component)) !== resolved
      ) {
        return refused('changed');
      }
      const bytes = buffer.subarray(0, used);
      if (budget) {
        if (used > budget.bytes) return refused('budget');
        budget.bytes -= used;
      }
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch {
        return refused('invalid-utf8');
      }
      return {
        status: 'ok',
        text,
        bytes: used,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        resolved: relative(root, resolved),
        links,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return refused('not-found');
    // Includes a symlink target that is not UTF-8 (the decoder throws).
    return refused('unreadable');
  }
}

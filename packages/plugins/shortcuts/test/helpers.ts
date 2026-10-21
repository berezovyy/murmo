import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapsPatch } from '@murmo/core/testing';
import { type CompileShortcut, compileShortcuts, shortcutsPlugin } from '../src/index.ts';

export const expectedPath = fileURLToPath(
  new URL('../../../../fixtures/shortcuts/replacements/expected.json', import.meta.url),
);

export function tempDir(prefix: string): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export function gitRepo(dir: string, files: Readonly<Record<string, string>>): string {
  mkdirSync(join(dir, '.git'), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return dir;
}

export function seeds(
  entries: Readonly<Record<string, string>>,
  origin: 'user' | 'project' = 'user',
): CompileShortcut[] {
  return Object.entries(entries).map(([shortcut, text]) => ({ shortcut, text, origin }));
}

export function pluginOf(
  entries: Readonly<Record<string, string>>,
  options: { asyncEdits?: boolean; inlineMaxBytes?: number } = {},
) {
  return shortcutsPlugin(compileShortcuts({ replacements: seeds(entries), ...options }), options);
}

export type HostName = 'pi' | 'opencode' | 'codex' | 'claude';

export const HOST_CAPS: Record<
  HostName,
  { compile: { asyncEdits: boolean; inlineMaxBytes: number }; caps: CapsPatch }
> = {
  pi: { compile: { asyncEdits: true, inlineMaxBytes: 16384 }, caps: {} },
  opencode: { compile: { asyncEdits: true, inlineMaxBytes: 16384 }, caps: {} },
  codex: { compile: { asyncEdits: true, inlineMaxBytes: 900 }, caps: { inline: { maxBytes: 900 } } },
  claude: {
    compile: { asyncEdits: false, inlineMaxBytes: 1024 },
    caps: { edit: { atomic: false }, inline: { maxBytes: 1024 } },
  },
};

export function storeRoots(dir: string) {
  return { data: join(dir, 'data', 'murmo'), state: join(dir, 'state', 'murmo'), cache: join(dir, 'cache', 'murmo') };
}

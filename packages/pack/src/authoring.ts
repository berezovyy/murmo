// What a plugin author needs from the packed product, next to `cli.mjs`: the
// public API types `murmo plugin new` copies into a scaffold, the authoring
// guide with the API docs it links, and the compiled examples it walks through.

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Docs that a plugin author reads; PORTING.md is for adapter writers. */
const AUTHOR_DOCS = ['AUTHORING.md', 'api.md', 'CHANGELOG.md', 'MANIFEST.md', 'events.md'] as const;

export function packAuthoring(packageDir: string, repoRoot: string): void {
  const api = join(repoRoot, 'packages/api');
  const report = join(api, 'report');
  if (!existsSync(join(report, 'index.d.ts'))) throw new Error('missing packages/api/report; run pnpm api:report');
  mkdirSync(join(packageDir, 'types'), { recursive: true });
  for (const name of readdirSync(report).filter((file) => file.endsWith('.d.ts'))) {
    cpSync(join(report, name), join(packageDir, 'types', name));
  }
  mkdirSync(join(packageDir, 'docs'), { recursive: true });
  for (const name of AUTHOR_DOCS) cpSync(join(api, 'docs', name), join(packageDir, 'docs', name));
  // AUTHORING.md links `../examples/<name>/plugin.ts`, so the folder sits beside docs/.
  for (const example of readdirSync(join(api, 'examples'))) {
    for (const file of ['plugin.ts', 'murmo.plugin.json']) {
      const source = join(api, 'examples', example, file);
      if (!existsSync(source)) continue;
      mkdirSync(join(packageDir, 'examples', example), { recursive: true });
      cpSync(source, join(packageDir, 'examples', example, file));
    }
  }
}

// Copy the public author types into a scaffold. Editor-only; the plugin
// module stays self-contained.

import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the packed tree keeps the author types and guide, next to `cli.mjs`. */
export const PACKED_TYPES = 'types';
export const PACKED_GUIDE = 'docs/AUTHORING.md';

const here = dirname(fileURLToPath(import.meta.url));

/** The first existing of the packed copy (the CLI bundle sits at the package root) and the repo's report. */
function firstExisting(candidates: readonly string[], probe: string): string {
  return candidates.find((dir) => existsSync(join(dir, probe))) ?? (candidates.at(-1) as string);
}

export function apiReportDir(): string {
  return firstExisting([join(here, PACKED_TYPES), join(here, '../../api/report')], 'index.d.ts');
}

/** The plugin authoring guide a user can open: shipped in the package, or the repo's copy. */
export function authoringGuide(): string {
  const packed = join(here, PACKED_GUIDE);
  return existsSync(packed) ? packed : join(here, '../../api/docs/AUTHORING.md');
}

export async function copyPublicTypes(directory: string): Promise<string> {
  const dest = join(directory, 'murmo-api');
  await mkdir(dest, { recursive: true });
  await cp(apiReportDir(), dest, { recursive: true });
  return dest;
}

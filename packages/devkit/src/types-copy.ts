// Copy the public author types into a scaffold. Editor-only; the plugin
// module stays self-contained.

import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function apiReportDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../api/report');
}

export async function copyPublicTypes(directory: string): Promise<string> {
  const dest = join(directory, 'murmo-api');
  await mkdir(dest, { recursive: true });
  await cp(apiReportDir(), dest, { recursive: true });
  return dest;
}

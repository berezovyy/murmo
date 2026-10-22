import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { API_VERSION } from '@murmo/api';
import { assertApiCompatible, ENVELOPE_FILE, inspectPluginFiles } from '@murmo/integrity';
import { extensionsDir, type StoreRoots } from '@murmo/store';
import type { InstalledPlugin } from '@murmo/store/node';
import { fail } from './errors.ts';

function readTree(dir: string, prefix = ''): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(path);
    if (st.isDirectory()) Object.assign(out, readTree(path, rel));
    else if (st.isFile()) out[rel] = readFileSync(path);
    else fail('installed-file-mismatch', { rel, reason: 'not-a-file' });
  }
  return out;
}

export function verifyInstalled(roots: StoreRoots, plugin: InstalledPlugin): void {
  const dist = plugin.distribution;
  if (!dist) return;
  const id = String(dist.manifest.id ?? '');
  const dir = extensionsDir(roots, id, dist.digest);
  const files = readTree(dir);
  if (!files[ENVELOPE_FILE]) fail('installed-file-mismatch', { rel: ENVELOPE_FILE });
  const inspected = inspectPluginFiles(files, dist.digest);
  if (inspected.publisher !== dist.publisher) {
    fail('installed-signature-mismatch', { expected: dist.publisher, actual: inspected.publisher });
  }
  if (inspected.digest !== dist.digest) fail('installed-file-mismatch', { digest: inspected.digest });
  assertApiCompatible(inspected.envelope.api, API_VERSION);
}

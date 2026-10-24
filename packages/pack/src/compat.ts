// Generated from the last green harness matrix and fake-host records. Setup
// warns outside it; adapters never refuse to load on version alone (lesson 23).

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, ENGINES_NODE, sha256Bytes } from '@murmo/integrity';

export interface CompatFile {
  readonly generatedFrom: string;
  readonly node: { readonly engines: string; readonly tested: readonly string[] };
  readonly platforms: readonly string[];
  readonly glibc: { readonly min: string; readonly builder: string };
  readonly hosts: Record<string, unknown>;
}

export function buildCompat(repoRoot: string): CompatFile {
  const hosts: Record<string, unknown> = {};
  const recordsDir = join(repoRoot, 'packages/fake-host/records');
  for (const name of readdirSync(recordsDir).sort()) {
    if (!name.endsWith('.json')) continue;
    hosts[name.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(recordsDir, name), 'utf8'));
  }
  const matrix = readFileSync(join(repoRoot, 'harness/matrix.toml'), 'utf8');
  const versions: Record<string, string[]> = {};
  const unsupported: Record<string, string[]> = {};
  let current = '';
  for (const line of matrix.split('\n')) {
    const host = line.match(/^\[hosts\.(\w+)\]$/);
    if (host) {
      current = host[1] as string;
      continue;
    }
    const list = line.match(/^(versions|unsupported)\s*=\s*\[(.*)\]/);
    if (list && current) {
      const names = [...(list[2] as string).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
      (list[1] === 'versions' ? versions : unsupported)[current] = names;
    }
  }
  // The harness still probes an unsupported version; the package never claims it.
  for (const [host, list] of Object.entries(versions)) {
    const rec = hosts[host];
    const off = unsupported[host] ?? [];
    if (rec && typeof rec === 'object') {
      hosts[host] = {
        ...rec,
        matrix: list.filter((version) => !off.includes(version)),
        ...(off.length ? { unsupported: off } : {}),
      };
    }
  }
  return {
    generatedFrom: 'harness/matrix.toml + packages/fake-host/records',
    node: { engines: ENGINES_NODE, tested: ['24.18.0', '24.22.0'] },
    platforms: ['darwin-arm64', 'linux-arm64'],
    glibc: { min: '2.36', builder: 'debian-bookworm' },
    hosts,
  };
}

export function writeCompat(packageDir: string, compat: CompatFile): string {
  const json = `${canonicalJson(compat)}\n`;
  writeFileSync(join(packageDir, 'compat.json'), json);
  return sha256Bytes(json.slice(0, -1));
}

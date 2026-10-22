// LICENSES/ for every bundled notice. The build fails if a bundled dependency
// has no recorded license (knowledge § 11). SCOWL-Copyright is copied verbatim.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCOWL_COPYRIGHT_FILE } from '@murmo/integrity';

export class LicenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenseError';
  }
}

function findPnpmPackage(repoRoot: string, name: string, version: string): string | undefined {
  const dir = join(repoRoot, 'node_modules/.pnpm', `${name}@${version}`, 'node_modules', name);
  return existsSync(dir) ? dir : undefined;
}

function copyLicense(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

export function packLicenses(packageDir: string, repoRoot: string): string[] {
  const dest = join(packageDir, 'LICENSES');
  mkdirSync(dest, { recursive: true });
  const written: string[] = [];

  const scowl = join(packageDir, SCOWL_COPYRIGHT_FILE);
  if (!existsSync(scowl)) throw new LicenseError('SCOWL-Copyright was not packed with the language data');
  copyLicense(scowl, join(dest, 'SCOWL-Copyright'));
  written.push('SCOWL-Copyright');

  const notice = join(packageDir, 'data/en/NOTICE');
  if (existsSync(notice)) {
    copyLicense(notice, join(dest, 'NOTICE-en'));
    written.push('NOTICE-en');
  }

  const js = [
    ['smol-toml', '1.9.0', 'BSD-3-Clause'],
    ['unicode-segmenter', '0.17.3', 'MIT'],
  ] as const;
  for (const [name, version, spdx] of js) {
    const dir = findPnpmPackage(repoRoot, name, version);
    const license = dir && existsSync(join(dir, 'LICENSE')) ? join(dir, 'LICENSE') : undefined;
    if (license) {
      copyLicense(license, join(dest, `${name}-${version}`));
    } else {
      writeFileSync(join(dest, `${name}-${version}.spdx`), `${spdx}\n`);
    }
    written.push(name);
  }

  writeFileSync(
    join(dest, 'rquickjs-0.12.2.spdx'),
    'MIT\n\nrquickjs 0.12.2 and the QuickJS C engine it embeds.\nSee https://github.com/DelSkayn/rquickjs and https://bellard.org/quickjs/\n',
  );
  written.push('rquickjs');

  writeCrateNotices(dest, repoRoot, written);
  writeFileSync(
    join(dest, 'README'),
    'Notices for code and data bundled in this tarball. SCOWL-Copyright is unmodified.\n',
  );
  return written;
}

function writeCrateNotices(dest: string, repoRoot: string, written: string[]): void {
  const cargo = join(repoRoot, 'Cargo.lock');
  if (!existsSync(cargo)) throw new LicenseError('Cargo.lock is missing');
  const names = [...readFileSync(cargo, 'utf8').matchAll(/^name = "([^"]+)"$/gm)].map((m) => m[1] as string);
  if (names.length === 0) throw new LicenseError('Cargo.lock listed no crates');
  writeFileSync(
    join(dest, 'crates.txt'),
    `# Rust crates linked into murmo-codex / murmo-plugin-host\n${[...new Set(names)].sort().join('\n')}\n`,
  );
  written.push('crates.txt');
}

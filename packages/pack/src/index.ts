import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyMode,
  buildManifest,
  CLI_FILE,
  keyIdOf,
  listPackageFiles,
  MODE_EXEC,
  MODE_FILE,
  PACKAGE_VERSION,
  publicFromPrivate,
  readSigningKey,
  sha256Bytes,
  writeSigned,
} from '@murmo/integrity';
import { generatedPackageJson, packAdapters } from './adapters.ts';
import { npmPack } from './archive.ts';
import { packAuthoring } from './authoring.ts';
import { packBinaries } from './binaries.ts';
import { buildCompat, writeCompat } from './compat.ts';
import { packLanguageData } from './data.ts';
import { packLicenses } from './licenses.ts';
import { repoRoot as defaultRoot, gitCommit, gitEpoch } from './root.ts';
import { scanRelease } from './scan-pack.ts';

export { generatedPackageJson } from './adapters.ts';
export { glibcTooNew, glibcVersions } from './binaries.ts';
export { checkTableBytes, DataError, packLanguageData } from './data.ts';
export { scanRelease } from './scan-pack.ts';

export interface PackOptions {
  readonly repoRoot?: string;
  readonly outDir?: string;
  readonly signingKey?: string;
  readonly unsigned?: boolean;
  readonly withX64?: boolean;
  readonly linuxBinDir?: string;
  readonly skipBinaries?: boolean;
  readonly skipData?: boolean;
  readonly skipBuild?: boolean;
  readonly skipScan?: boolean;
}

export interface PackResult {
  readonly packageDir: string;
  readonly tarball?: string;
  readonly keyId?: string;
  readonly shipped: readonly string[];
}

export function pack(options: PackOptions = {}): PackResult {
  const repoRoot = options.repoRoot ?? defaultRoot;
  const outDir = options.outDir ?? join(repoRoot, 'dist', 'release');
  const packageDir = join(outDir, 'package');
  rmSync(packageDir, { recursive: true, force: true });
  mkdirSync(packageDir, { recursive: true });

  if (!options.skipBuild) {
    execFileSync(process.execPath, [join(repoRoot, 'tools/build.mjs')], { cwd: repoRoot, stdio: 'inherit' });
  }

  const pkg = generatedPackageJson();
  if ('scripts' in pkg) throw new Error('generated package.json must not have install scripts');
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  packAdapters(packageDir, repoRoot);
  copyCli(packageDir, repoRoot);
  packAuthoring(packageDir, repoRoot);

  if (!options.skipData) packLanguageData(packageDir, repoRoot);
  packLicenses(packageDir, repoRoot);
  const compatSha = writeCompat(packageDir, buildCompat(repoRoot));

  const shipped = options.skipBinaries
    ? []
    : packBinaries({
        repoRoot,
        packageDir,
        ...(options.withX64 ? { withX64: true } : {}),
        ...(options.linuxBinDir ? { linuxBinDir: options.linuxBinDir } : {}),
        ...(options.skipBuild ? { skipBuild: true } : {}),
      });

  for (const rel of listPackageFiles(packageDir)) {
    const exec = rel === CLI_FILE || rel.startsWith('bin/');
    applyMode(packageDir, rel, exec ? MODE_EXEC : MODE_FILE);
  }

  process.env.SOURCE_DATE_EPOCH ??= gitEpoch(repoRoot);

  let keyId: string | undefined;
  if (!options.unsigned) {
    const keyPath = options.signingKey ?? process.env.MURMO_SIGNING_KEY;
    if (!keyPath) throw new Error('MURMO_SIGNING_KEY (or --key) is required; pack does not generate keys');
    const privateKey = readSigningKey(keyPath);
    keyId = keyIdOf(publicFromPrivate(privateKey));
    const manifest = buildManifest(packageDir, {
      version: PACKAGE_VERSION,
      commit: gitCommit(repoRoot),
      keyId,
      compatSha256: compatSha,
    });
    writeSigned(packageDir, manifest, privateKey);
  }

  mkdirSync(outDir, { recursive: true });
  const tarball = npmPack(packageDir, outDir);
  if (!options.skipScan) {
    const hits = scanRelease(repoRoot, packageDir, tarball);
    if (hits.length) throw new Error(`private-key scan hits:\n${hits.map((h) => `${h.path}: ${h.why}`).join('\n')}`);
  }
  return { packageDir, tarball, shipped, ...(keyId ? { keyId } : {}) };
}

function copyCli(packageDir: string, repoRoot: string): void {
  const src = join(repoRoot, 'packages/cli/dist/node/cli.js');
  if (!existsSync(src)) throw new Error('missing CLI bundle; run pnpm build');
  const body = readFileSync(src);
  const shebang = Buffer.from('#!/usr/bin/env node\n');
  const withBang = body.subarray(0, 2).toString() === '#!' ? body : Buffer.concat([shebang, body]);
  writeFileSync(join(packageDir, CLI_FILE), withBang, { mode: MODE_EXEC });
  chmodSync(join(packageDir, CLI_FILE), MODE_EXEC);
}

export { sha256Bytes };

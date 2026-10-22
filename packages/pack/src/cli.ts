#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pack } from './index.ts';
import { gitCommit, repoRoot } from './root.ts';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2)): number {
  if (argv[0] === '-h' || argv[0] === '--help') {
    console.log(
      'usage: node tools/pack.mjs [--key PEM] [--out DIR] [--linux-bins DIR] [--with-x64] [--unsigned] [--skip-build] [--verify-reproducible]',
    );
    return 0;
  }
  const unsigned = argv.includes('--unsigned');
  const skipBuild = argv.includes('--skip-build');
  const skipBinaries = argv.includes('--skip-binaries');
  const withX64 = argv.includes('--with-x64');
  const out = arg(argv, '--out');
  const key = arg(argv, '--key');
  const linuxBins = arg(argv, '--linux-bins');
  if (argv.includes('--verify-reproducible')) {
    return verifyReproducible({
      unsigned,
      skipBuild,
      skipBinaries,
      withX64,
      ...(key ? { key } : {}),
      ...(linuxBins ? { linuxBins } : {}),
    });
  }
  const result = pack({
    ...(out ? { outDir: out } : {}),
    ...(key ? { signingKey: key } : {}),
    ...(unsigned ? { unsigned: true } : {}),
    ...(skipBuild ? { skipBuild: true } : {}),
    ...(skipBinaries ? { skipBinaries: true } : {}),
    ...(withX64 ? { withX64: true } : {}),
    ...(linuxBins ? { linuxBinDir: linuxBins } : {}),
  });
  console.log(
    JSON.stringify(
      { packageDir: result.packageDir, tarball: result.tarball, keyId: result.keyId, shipped: result.shipped },
      null,
      2,
    ),
  );
  return 0;
}

function verifyReproducible(opts: {
  unsigned: boolean;
  skipBuild: boolean;
  skipBinaries: boolean;
  withX64: boolean;
  key?: string;
  linuxBins?: string;
}): number {
  const a = mkdtempSync(join(tmpdir(), 'murmo-pack-a-'));
  const b = mkdtempSync(join(tmpdir(), 'murmo-pack-b-'));
  try {
    const common = {
      skipScan: true as const,
      ...(opts.unsigned ? { unsigned: true } : {}),
      ...(opts.skipBuild ? { skipBuild: true } : {}),
      ...(opts.skipBinaries ? { skipBinaries: true } : {}),
      ...(opts.withX64 ? { withX64: true } : {}),
      ...(opts.key ? { signingKey: opts.key } : {}),
      ...(opts.linuxBins ? { linuxBinDir: opts.linuxBins } : {}),
    };
    const ra = pack({ ...common, outDir: a });
    const rb = pack({ ...common, outDir: b });
    const ia = readFileSync(join(ra.packageDir, 'integrity.json'));
    const ib = readFileSync(join(rb.packageDir, 'integrity.json'));
    if (!ia.equals(ib)) {
      console.error('FAIL two clean packs of', gitCommit(repoRoot), 'produced different integrity.json');
      return 1;
    }
    console.log('reproducible integrity.json', ia.length, 'bytes');
    return 0;
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

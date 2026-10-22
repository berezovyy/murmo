// Prebuilt helpers. Native darwin-arm64 via tools/cargo.mjs; linux-arm64 from
// env, a directory, or the Bookworm builder script. x86_64 is behind --with-x64
// and ships only after phase 29.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BINARY_NAMES, binDir, MAX_BINARY_BYTES, MODE_EXEC, TESTED_PLATFORMS, X64_PLATFORMS } from '@murmo/integrity';

export class BinaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinaryError';
  }
}

export interface BinaryOptions {
  readonly repoRoot: string;
  readonly packageDir: string;
  readonly withX64?: boolean;
  readonly linuxBinDir?: string;
  readonly skipBuild?: boolean;
}

export function nativePlatform(): string {
  return `${process.platform}-${process.arch}`;
}

function envBin(platform: string, name: string): string | undefined {
  const key = `MURMO_BIN_${platform.replaceAll('-', '_').toUpperCase()}_${name.replaceAll('-', '_').toUpperCase()}`;
  return process.env[key];
}

export function copyBinary(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  chmodSync(dest, MODE_EXEC);
  const size = statSync(dest).size;
  if (size > MAX_BINARY_BYTES) throw new BinaryError(`${dest} is ${size} bytes, over the 2 MB target`);
  if ((statSync(dest).mode & 0o777) !== MODE_EXEC) throw new BinaryError(`${dest} is not mode 0755`);
}

function cargoRelease(repoRoot: string, crate: string): string {
  execFileSync(
    process.execPath,
    [join(repoRoot, 'tools/cargo.mjs'), 'build', '--release', '--locked', '--offline', '-p', crate],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    },
  );
  const printed = execFileSync(process.execPath, [join(repoRoot, 'tools/cargo.mjs'), '--print-target-dir'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const bin = join(printed, 'release', crate);
  if (!existsSync(bin)) throw new BinaryError(`cargo --release -p ${crate} did not write ${bin}`);
  return bin;
}

export function packBinaries(options: BinaryOptions): string[] {
  const platforms = options.withX64 ? [...TESTED_PLATFORMS, ...X64_PLATFORMS] : [...TESTED_PLATFORMS];
  const shipped: string[] = [];
  const native = nativePlatform();

  for (const name of BINARY_NAMES) {
    if (!options.skipBuild && native === 'darwin-arm64') {
      const built = cargoRelease(options.repoRoot, name);
      copyBinary(built, join(options.packageDir, binDir(native), name));
      shipped.push(`${native}/${name}`);
    }
  }

  for (const platform of platforms) {
    for (const name of BINARY_NAMES) {
      const dest = join(options.packageDir, binDir(platform), name);
      if (existsSync(dest)) continue;
      const fromEnv = envBin(platform, name);
      const fromDir = options.linuxBinDir ? join(options.linuxBinDir, platform, name) : undefined;
      const src = fromEnv ?? (fromDir && existsSync(fromDir) ? fromDir : undefined);
      if (src) {
        copyBinary(src, dest);
        shipped.push(`${platform}/${name}`);
      }
    }
  }

  const nativeShipped = BINARY_NAMES.every((n) => existsSync(join(options.packageDir, binDir(native), n)));
  if (!nativeShipped && !options.skipBuild) {
    throw new BinaryError(`missing native ${native} helpers after the cargo release build`);
  }
  return shipped;
}

export function glibcVersions(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString('latin1');
  const found = new Set<string>();
  const re = /GLIBC_(\d+\.\d+)/g;
  for (const m of text.matchAll(re)) found.add(m[1] as string);
  return [...found].sort(compareDot);
}

export function glibcTooNew(versions: readonly string[], floor = '2.36'): string[] {
  return versions.filter((v) => compareDot(v, floor) > 0);
}

function compareDot(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

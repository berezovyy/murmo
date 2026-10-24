// Staged copy, exec-bit restore (E15), atomic rename, payload generations,
// PATH launcher that never edits shell rc files (docs/plan/27).

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BINARY_NAMES,
  CLI_FILE,
  CODEX_NAME,
  DATA_DIR,
  helperPath,
  INTEGRITY_FILE,
  MODE_EXEC,
  npmPlatform,
  sha256Bytes,
  TESTED_PLATFORMS,
} from '@murmo/integrity';
import { installLanguagePack } from '@murmo/lang/node';
import { CliError } from './errors.ts';
import { type HomeLayout, localBinOnPath } from './home.ts';
import type { Journal, LauncherRecord } from './journal.ts';

export interface IncomingPackage {
  readonly root: string;
  readonly version: string;
  readonly sha256: string;
}

export function packagePin(root: string, version: string): IncomingPackage {
  return { root, version, sha256: sha256Bytes(readFileSync(join(root, INTEGRITY_FILE))) };
}

export function restoreExecBits(root: string): void {
  const platform = npmPlatform();
  const files = [CLI_FILE, ...BINARY_NAMES.map((name) => join('bin', platform, name))];
  for (const rel of files) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    // Only a lost bit is written back: a package on a read-only mount refuses any chmod.
    if ((statSync(path).mode & 0o777) !== MODE_EXEC) chmodSync(path, MODE_EXEC);
  }
}

export function helperAvailability(root: string): {
  helper?: string;
  codex?: string;
  helperRequired: boolean;
  warning?: string;
} {
  const platform = npmPlatform();
  const required = (TESTED_PLATFORMS as readonly string[]).includes(platform);
  const helper = join(root, helperPath(platform));
  const codex = join(root, 'bin', platform, CODEX_NAME);
  const helperOk = existsSync(helper) && (statSync(helper).mode & 0o111) !== 0;
  const codexOk = existsSync(codex) && (statSync(codex).mode & 0o111) !== 0;
  if (required && !helperOk) {
    throw new CliError(`missing platform helper ${helperPath(platform)}`, {
      action: 'reinstall the Murmo package for this architecture',
    });
  }
  if (!helperOk || !codexOk) {
    return {
      ...(helperOk ? { helper } : {}),
      ...(codexOk ? { codex } : {}),
      helperRequired: required,
      warning: 'Codex wrapper and third-party plugins unavailable on this platform',
    };
  }
  return { helper, codex, helperRequired: required };
}

export function copyPayload(source: string, staging: string): void {
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(staging), { recursive: true });
  cpSync(source, staging, { recursive: true });
  restoreExecBits(staging);
}

export function switchPayload(layout: HomeLayout, staging: string, journal: Journal): string | undefined {
  let moved: string | undefined;
  if (existsSync(layout.payload)) {
    const gen = join(
      layout.generations,
      `${journal.package.version}-${journal.package.sha256.slice(0, 12) || 'current'}`,
    );
    mkdirSync(dirname(gen), { recursive: true });
    if (existsSync(gen)) rmSync(gen, { recursive: true, force: true });
    renameSync(layout.payload, gen);
    moved = gen;
  }
  renameSync(staging, layout.payload);
  return moved;
}

export function validateLanguage(payload: string, recordFile: string): void {
  const packDir = join(payload, DATA_DIR);
  if (!existsSync(join(packDir, 'manifest.json'))) {
    throw new CliError(`language pack missing at ${DATA_DIR}`, {
      action: 'reinstall the Murmo package; data/en is required',
    });
  }
  const digestFile = join(packDir, 'digest.json');
  const installed = installLanguagePack(packDir, recordFile);
  if (existsSync(digestFile)) {
    const digest = JSON.parse(readFileSync(digestFile, 'utf8')) as {
      sha256?: string;
      entries?: number;
      bytes?: number;
    };
    const table = installed.record.receipt.table;
    if (digest.sha256 !== table.sha256 || digest.entries !== table.entries || digest.bytes !== table.bytes) {
      throw new CliError('language pack does not match data/en/digest.json', {
        action: 'reinstall the Murmo package; the table was rebuilt or tampered',
      });
    }
  }
}

export function writeLauncher(layout: HomeLayout, env: NodeJS.ProcessEnv): { record: LauncherRecord; onPath: boolean } {
  const target = join(layout.payload, CLI_FILE);
  const body = `#!/bin/sh\nexec "${target}" "$@"\n`;
  mkdirSync(layout.localBin, { recursive: true });
  const tmp = `${layout.launcher}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: MODE_EXEC });
  chmodSync(tmp, MODE_EXEC);
  renameSync(tmp, layout.launcher);
  chmodSync(layout.launcher, MODE_EXEC);
  return {
    record: { path: layout.launcher, sha256: sha256Bytes(Buffer.from(body)) },
    onPath: localBinOnPath(layout, env),
  };
}

export function versionCmp(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

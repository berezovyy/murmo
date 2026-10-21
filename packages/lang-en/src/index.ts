// @murmo/lang-en: the English language pack, built from pinned inputs
// (inputs/sources.json) by our own pipeline. The pack itself is not committed:
// `ensurePack()` builds it into dist/pack/ once per input and code change, and
// expected.json pins the hashes a clean build must reproduce.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPack } from './build.ts';
import { defaultInputsDir, packageDir } from './inputs.ts';

export { BuildError, type BuildReport, buildPack, PIPELINE_VERSION } from './build.ts';
export { formatGate, type GateResult, r6Dictionary, readGateConfig, runGate } from './gate/index.ts';
export { defaultInputsDir, loadInputs, packageDir, pinInputs } from './inputs.ts';
export { DATA_POLICY, PACK_FILES } from './policy.ts';
export { VerifyError, type VerifyReport, verifyPack } from './verify.ts';

export const defaultPackDir = join(packageDir, 'dist', 'pack');
const DIGEST_FILE = '.build-digest';
const langSrc = fileURLToPath(new URL('../../lang/src/', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

/** Hash of everything a build reads: the pinned inputs and the code of both packages. */
export function buildDigest(inputsDir = defaultInputsDir): string {
  const h = createHash('sha256');
  for (const file of [...files(inputsDir), ...files(join(packageDir, 'src')), ...files(langSrc)]) {
    h.update(relative(dirname(packageDir), file))
      .update('\0')
      .update(readFileSync(file))
      .update('\0');
  }
  return h.digest('hex');
}

/** Builds the pack into `dir` unless it already holds a build of the same inputs and code; returns `dir`. */
export function ensurePack(dir = defaultPackDir): string {
  const digest = buildDigest();
  const current = () => existsSync(join(dir, DIGEST_FILE)) && readFileSync(join(dir, DIGEST_FILE), 'utf8') === digest;
  if (current()) return dir;
  mkdirSync(dirname(dir), { recursive: true });
  const temp = mkdtempSync(`${dir}.tmp-`);
  try {
    buildPack(temp);
    writeFileSync(join(temp, DIGEST_FILE), digest);
    if (!current()) {
      rmSync(dir, { recursive: true, force: true });
      renameSync(temp, dir);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return dir;
}

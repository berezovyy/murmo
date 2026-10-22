#!/usr/bin/env node
// Packed `murmo` entry. setup/uninstall/doctor are phase 27; this file is the
// seam they mount. The trust-anchor key is never baked in (E4).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  CODEX_NAME,
  INTEGRITY_FILE,
  loadTrustAnchor,
  PACKAGE_VERSION,
  parseManifest,
  verifyPackage,
} from '@murmo/integrity';
import { packageRoot, platformBin } from './paths.ts';

const usage = `murmo ${PACKAGE_VERSION}
  murmo --version
  murmo verify [--key PUBLIC.pem]
  murmo codex [args...]
  murmo setup | uninstall | doctor   (phase 27)
`;

export function main(argv = process.argv.slice(2)): number {
  const [cmd, ...rest] = argv;
  if (cmd === '-h' || cmd === '--help' || cmd === 'help' || cmd === undefined) {
    process.stdout.write(usage);
    return cmd === undefined ? 2 : 0;
  }
  if (cmd === '-V' || cmd === '--version' || cmd === 'version') {
    console.log(PACKAGE_VERSION);
    return 0;
  }
  if (cmd === 'verify') return verifyCmd(rest);
  if (cmd === 'codex') return codexCmd(rest);
  if (cmd === 'setup' || cmd === 'uninstall' || cmd === 'doctor') {
    console.error(`murmo ${cmd}: not in this package (phase 27)`);
    return 2;
  }
  console.error(`murmo: unknown command ${cmd}\n${usage}`);
  return 2;
}

function verifyCmd(argv: string[]): number {
  const keyIdx = argv.indexOf('--key');
  const keyPath = keyIdx >= 0 ? argv[keyIdx + 1] : undefined;
  const root = packageRoot();
  const integrity = joinIntegrity(root);
  const parsed = parseManifest(JSON.parse(readFileSync(integrity, 'utf8')));
  const anchor = loadTrustAnchor(keyPath ? { keyPath } : {});
  if (!anchor) {
    console.error(
      `murmo verify: no trust anchor (pass --key or MURMO_TRUST_KEY). integrity keyId=${parsed.keyId}. The verifying key is not in this tarball.`,
    );
    verifyPackage(root);
    console.log(`files match integrity.json (unauthenticated bit-rot check) keyId=${parsed.keyId}`);
    return 0;
  }
  const result = verifyPackage(root, { publicKey: anchor.publicKey });
  console.log(`ok authenticated keyId=${result.keyId} fingerprint=${result.fingerprint}`);
  return 0;
}

function joinIntegrity(root: string): string {
  const path = `${root}/${INTEGRITY_FILE}`;
  if (!existsSync(path)) throw new Error(`${INTEGRITY_FILE} is missing; this CLI is not in a packed tree`);
  return path;
}

function codexCmd(argv: string[]): number {
  const bin = platformBin(CODEX_NAME);
  if (!existsSync(bin)) {
    console.error(`murmo codex: ${bin} is missing (Codex wrapper unavailable on this platform)`);
    return 1;
  }
  const run = spawnSync(bin, argv, { stdio: 'inherit' });
  return run.status ?? 1;
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('cli.js') ||
  process.argv[1]?.endsWith('cli.mjs')
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`murmo: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

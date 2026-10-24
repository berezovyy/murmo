#!/usr/bin/env node
// Packed `murmo` entry. Trust-anchor key is never baked in (E4).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeConfig, parseConfig, resolveShortcuts } from '@murmo/config';
import { loadSessionConfig, userConfigPath } from '@murmo/config/node';
import {
  CODEX_NAME,
  INTEGRITY_FILE,
  loadTrustAnchor,
  PACKAGE_VERSION,
  parseManifest,
  TABLE_FILE,
  verifyPackage,
} from '@murmo/integrity';
import { openStore, storeRootsFromEnv } from '@murmo/store/node';
import { askStdin, dispatchMounted } from './commands.ts';
import { doctorCommand, doctorExit, printDoctor } from './doctor.ts';
import { formatError } from './errors.ts';
import { homeLayout } from './home.ts';
import { hookCommand } from './hook.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { packageRoot, platformBin } from './paths.ts';
import { pluginCommand } from './plugin/index.ts';
import { printSetup, setupCommand } from './setup.ts';
import { printUninstall, uninstallCommand } from './uninstall.ts';

const usage = `murmo ${PACKAGE_VERSION}
  murmo --version
  murmo verify [--key PUBLIC.pem]
  murmo setup [--json] [--key PUBLIC.pem] [--package DIR]
  murmo uninstall [--json]
  murmo doctor [--json] [--stats] [--key PUBLIC.pem]
  murmo codex [args...]
  murmo plugin new|test|dev
  murmo plugin list|inspect|search|info|add|update|disable|enable|remove|rollback|reinstall|doctor
  murmo trust | init | vocab | words | names | index | phrases | history | data | private | shortcuts save
  murmo hook codex <event>
`;

export interface MainOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly out?: (text: string) => void;
  readonly err?: (text: string) => void;
  /** Answers a review prompt (`murmo trust`, `murmo shortcuts save`); default reads stdin. */
  readonly ask?: (prompt: string) => Promise<string>;
}

const VALUE_FLAGS = new Set(['--key', '--package']);
const BARE_FLAGS = new Set(['--json', '--stats']);

function parseFlags(args: readonly string[]): { positional: string[]; flags: Map<string, string | true> } | string {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
      if (flags.has(arg)) return `${arg} given twice`;
      flags.set(arg, value);
      i++;
    } else if (BARE_FLAGS.has(arg)) flags.set(arg, true);
    else if (arg.startsWith('--')) return `unknown option ${arg}`;
    else positional.push(arg);
  }
  return { positional, flags };
}

export async function main(argv = process.argv.slice(2), options: MainOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const out = options.out ?? ((s: string) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`));
  const err = options.err ?? ((s: string) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`));
  const mounted = { out, err, ask: options.ask ?? askStdin };
  const [cmd, ...rest] = argv;
  if (cmd === '-h' || cmd === '--help' || cmd === 'help' || cmd === undefined) {
    out(usage);
    return cmd === undefined ? 2 : 0;
  }
  if (cmd === '-V' || cmd === '--version' || cmd === 'version') {
    out(PACKAGE_VERSION);
    return 0;
  }
  try {
    if (cmd === 'verify') return verifyCmd(rest, env, out, err);
    if (cmd === 'codex') return await codexCmd(rest, env, err);
    if (cmd === 'setup' || cmd === 'uninstall' || cmd === 'doctor') {
      const parsed = parseFlags(rest);
      if (typeof parsed === 'string') {
        err(`${parsed}\n${usage}`);
        return 2;
      }
      const json = parsed.flags.has('--json');
      const stats = parsed.flags.has('--stats');
      const keyPath = parsed.flags.get('--key');
      const pkgFlag = parsed.flags.get('--package');
      const root = typeof pkgFlag === 'string' ? pkgFlag : env.MURMO_PACKAGE_ROOT || packageRoot();
      if (cmd === 'setup' || cmd === 'uninstall') {
        const layout = homeLayout(env);
        const lock = acquireLock(layout.data, env);
        try {
          if (cmd === 'setup') {
            const report = await setupCommand({
              env,
              packageRoot: root,
              json,
              ...(typeof keyPath === 'string' ? { keyPath } : {}),
            });
            printSetup(report, json, out);
            return 0;
          }
          const report = uninstallCommand({ env, json });
          printUninstall(report, json, out);
          return 0;
        } finally {
          releaseLock(lock);
        }
      }
      const report = await doctorCommand({
        env,
        json,
        stats,
        ...(existsSync(root) ? { packageRoot: root } : {}),
        ...(typeof keyPath === 'string' ? { keyPath } : {}),
      });
      printDoctor(report, json, out);
      return doctorExit(report);
    }
    if (cmd === 'plugin') {
      const verb = rest[0];
      if (verb === 'new' || verb === 'test' || verb === 'dev') {
        return await dispatchMounted(cmd, rest, env, cwd, mounted);
      }
      const packed = existsSync(`${packageRoot()}/${INTEGRITY_FILE}`);
      // Awaited here, so a refusal reaches the catch below and prints its details.
      return await pluginCommand(
        {
          roots: storeRootsFromEnv(env, env.HOME),
          cwd,
          packed,
          out,
          err,
          ask: mounted.ask,
        },
        rest,
      );
    }
    if (cmd === 'hook') {
      const stdin = env.MURMO_HOOK_STDIN ?? (process.stdin.isTTY ? '{}' : await readStdin());
      return hookCommand(rest, env, stdin, out);
    }
    if (
      [
        'trust',
        'init',
        'vocab',
        'words',
        'names',
        'index',
        'phrases',
        'history',
        'data',
        'private',
        'shortcuts',
      ].includes(cmd)
    ) {
      return await dispatchMounted(cmd, rest, env, cwd, mounted);
    }
    err(`murmo: unknown command ${cmd}\n${usage}`);
    return 2;
  } catch (error) {
    const formatted = formatError(error);
    err(`murmo: ${formatted.message}${formatted.action ? `\n  action: ${formatted.action}` : ''}`);
    return formatted.code;
  }
}

function verifyCmd(argv: string[], env: NodeJS.ProcessEnv, out: (s: string) => void, err: (s: string) => void): number {
  const keyIdx = argv.indexOf('--key');
  const keyPath = keyIdx >= 0 ? argv[keyIdx + 1] : undefined;
  const pkgIdx = argv.indexOf('--package');
  const root = pkgIdx >= 0 && argv[pkgIdx + 1] ? (argv[pkgIdx + 1] as string) : env.MURMO_PACKAGE_ROOT || packageRoot();
  const integrity = `${root}/${INTEGRITY_FILE}`;
  if (!existsSync(integrity)) throw new Error(`${INTEGRITY_FILE} is missing; this CLI is not in a packed tree`);
  const parsed = parseManifest(JSON.parse(readFileSync(integrity, 'utf8')));
  const anchor = loadTrustAnchor({ ...(keyPath ? { keyPath } : {}), env });
  if (!anchor) {
    err(
      `murmo verify: no trust anchor (pass --key or MURMO_TRUST_KEY). integrity keyId=${parsed.keyId}. The verifying key is not in this tarball.`,
    );
    verifyPackage(root);
    out(`files match integrity.json (unauthenticated bit-rot check) keyId=${parsed.keyId}`);
    return 0;
  }
  const result = verifyPackage(root, { publicKey: anchor.publicKey });
  out(`ok authenticated keyId=${result.keyId} fingerprint=${result.fingerprint}`);
  return 0;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      chunks.push(String(chunk));
    });
    process.stdin.on('end', () => resolve(chunks.join('') || '{}'));
  });
}

function userFileAutocorrect(env: NodeJS.ProcessEnv): boolean {
  const path = userConfigPath(env);
  if (!existsSync(path)) return false;
  try {
    const parsed = parseConfig(readFileSync(path, 'utf8'), { file: path, origin: 'user' });
    if (parsed.status !== 'ok') return false;
    return mergeConfig({ user: resolveShortcuts(parsed, new Map()), projectTrusted: false }).autocorrect;
  } catch {
    return false;
  }
}

/** JSON object `{ ";rvw": "…", … }` for the Codex wrapper (`MURMO_SHORTCUTS`). */
export function shortcutsEnvJson(
  replacements: readonly { readonly shortcut: string; readonly text: string }[],
): string | undefined {
  if (replacements.length === 0) return undefined;
  const map: Record<string, string> = {};
  for (const entry of replacements) map[entry.shortcut] = entry.text;
  return JSON.stringify(map);
}

/** Env the wrapper needs so packed `murmo codex` loads english.bin, user autocorrect, and shortcuts. */
export async function codexChildEnv(
  env: NodeJS.ProcessEnv,
  packedRoot: string,
  cwd: string = env.PWD || process.cwd(),
): Promise<NodeJS.ProcessEnv> {
  const next: NodeJS.ProcessEnv = { ...env };
  if (!next.MURMO_PACKAGE_ROOT) next.MURMO_PACKAGE_ROOT = packedRoot;
  const table = join(packedRoot, TABLE_FILE);
  if (!next.MURMO_ENGLISH_TABLE && existsSync(table)) next.MURMO_ENGLISH_TABLE = table;
  if (next.MURMO_AUTOCORRECT === undefined && userFileAutocorrect(env)) next.MURMO_AUTOCORRECT = '1';
  if (!next.MURMO_SHORTCUTS) {
    try {
      const store = await openStore({ roots: storeRootsFromEnv(env, env.HOME) });
      const session = await loadSessionConfig({ cwd, store, env, ...(env.HOME ? { home: env.HOME } : {}) });
      const json = shortcutsEnvJson(session.effective.replacements);
      if (json) next.MURMO_SHORTCUTS = json;
    } catch {
      // Fail open: Codex still starts; shortcuts stay empty until config loads.
    }
  }
  return next;
}

function packedRootOf(env: NodeJS.ProcessEnv): string | undefined {
  if (env.MURMO_PACKAGE_ROOT && existsSync(join(env.MURMO_PACKAGE_ROOT, INTEGRITY_FILE))) {
    return env.MURMO_PACKAGE_ROOT;
  }
  try {
    const root = packageRoot();
    return existsSync(join(root, INTEGRITY_FILE)) ? root : undefined;
  } catch {
    return undefined;
  }
}

async function codexCmd(argv: string[], env: NodeJS.ProcessEnv, err: (s: string) => void): Promise<number> {
  const bin = platformBin(CODEX_NAME);
  if (!existsSync(bin)) {
    err(`murmo codex: ${bin} is missing (Codex wrapper unavailable on this platform)`);
    return 1;
  }
  const packed = packedRootOf(env);
  const child = packed ? await codexChildEnv(env, packed, env.PWD || process.cwd()) : env;
  const run = spawnSync(bin, argv, { stdio: 'inherit', env: child });
  return run.status ?? 1;
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('cli.ts') ||
  process.argv[1]?.endsWith('cli.js') ||
  process.argv[1]?.endsWith('cli.mjs')
) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`murmo: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    });
}

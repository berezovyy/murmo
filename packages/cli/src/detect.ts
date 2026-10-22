// PATH lookup, then `--version` in a throwaway HOME so OpenCode's --version
// writes never land in the target profile (r10 I1 / E2, lesson 53).

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HOST_NAMES, type HostName } from './home.ts';
import type { CommandResult, HostProbe } from './journal.ts';

export function lookup(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH || '').split(':')) {
    if (!dir) continue;
    const file = resolve(dir, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      // not on this PATH entry
    }
  }
  return undefined;
}

export function runCommand(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  host?: string,
  timeoutMs = 30_000,
): CommandResult {
  const t = performance.now();
  const r = spawnSync(file, [...args], { env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return {
    argv: [file, ...args],
    status: r.status,
    ms: performance.now() - t,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    ...(r.error ? { error: r.error.message } : {}),
    ...(host ? { host } : {}),
  };
}

function throwawayEnv(env: NodeJS.ProcessEnv, temp: string): NodeJS.ProcessEnv {
  const config = join(temp, 'config');
  const data = join(temp, 'data');
  const cache = join(temp, 'cache');
  const state = join(temp, 'state');
  const claude = join(temp, 'claude');
  const opencode = join(config, 'opencode');
  const opencodeConfig = join(opencode, 'opencode.json');
  mkdirSync(claude, { recursive: true });
  mkdirSync(opencode, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(cache, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(claude, 'settings.json'),
    `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_API_KEY: 'murmo-fake-key' } })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(opencodeConfig, '{}\n', { mode: 0o600 });
  return {
    ...env,
    HOME: temp,
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: join(temp, 'codex'),
    PI_CODING_AGENT_DIR: join(temp, 'pi'),
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    OPENCODE_CONFIG_DIR: opencode,
    OPENCODE_CONFIG: opencodeConfig,
    OPENCODE_TEST_HOME: temp,
    OPENCODE_CONFIG_PROJECT_DISABLE: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    ANTHROPIC_API_KEY: 'murmo-fake-key',
  };
}

export function detectHosts(env: NodeJS.ProcessEnv = process.env): HostProbe[] {
  const temp = mkdtempSync(join(env.TMPDIR || tmpdir(), 'murmo-probe-'));
  const probeEnv = throwawayEnv(env, temp);
  try {
    return HOST_NAMES.map((name: HostName) => {
      const executable = lookup(name, env);
      if (!executable) return { name, installed: false, skipped: 'not on PATH' };
      const result = runCommand(executable, ['--version'], probeEnv, name, 8_000);
      if (result.status !== 0) {
        return {
          name,
          executable,
          installed: false,
          skipped: result.stderr.trim() || result.error || 'non-zero --version',
        };
      }
      return { name, executable, installed: true, version: result.stdout.trim() };
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function throwawayLeftResidue(temp: string): boolean {
  return existsSync(temp);
}

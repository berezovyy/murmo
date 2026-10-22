// Official host registration. Never a `codex` shim (lesson 40). Claude
// marketplace is the local payload copy until phase 31 chooses the published
// source. Journal replay is the uninstall source of truth (docs/plan/27).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_NAME } from '@murmo/integrity';
import { runCommand } from './detect.ts';
import { CliError } from './errors.ts';
import type { HomeLayout } from './home.ts';
import type { CommandResult, HostProbe, Journal } from './journal.ts';

const MARKETPLACE = `${PACKAGE_NAME}-local`;

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function assertFakeClaude(layout: HomeLayout, env: NodeJS.ProcessEnv): void {
  if (env.MURMO_EXPERIMENT !== '1') return;
  const settings = readJson(`${layout.dirs.claude}/settings.json`);
  const values = (settings.env ?? {}) as Record<string, string>;
  const url = values.ANTHROPIC_BASE_URL ?? env.ANTHROPIC_BASE_URL;
  if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) {
    throw new CliError('fake Claude profile preflight failed', {
      action: 'point ANTHROPIC_BASE_URL at 127.0.0.1 before running under MURMO_EXPERIMENT=1',
    });
  }
}

export function registerHost(
  host: HostProbe,
  payload: string,
  layout: HomeLayout,
  env: NodeJS.ProcessEnv,
): CommandResult[] {
  if (!host.installed || !host.executable) return [];
  if (host.name === 'claude') {
    assertFakeClaude(layout, env);
    const results: CommandResult[] = [];
    for (const args of [
      ['plugin', 'marketplace', 'add', payload],
      ['plugin', 'install', `${PACKAGE_NAME}@${MARKETPLACE}`, '--scope', 'user'],
    ] as const) {
      const r = runCommand(host.executable, args, env, 'claude');
      results.push(r);
      if (r.status !== 0) {
        throw new CliError(`Claude registration failed: ${r.stderr.trim() || r.error || String(r.status)}`, {
          action: 'install Claude Code and re-run murmo setup',
        });
      }
    }
    return results;
  }
  if (host.name === 'pi') {
    const r = runCommand(host.executable, ['install', payload], env, 'pi');
    if (r.status !== 0) {
      throw new CliError(`Pi registration failed: ${r.stderr.trim() || r.error || String(r.status)}`, {
        action: 'install Pi and re-run murmo setup',
      });
    }
    return [r];
  }
  if (host.name === 'opencode') {
    const file = `${layout.dirs.opencode}/cli.json`;
    const current = readJson(file);
    const href = pathToFileURL(payload).href;
    const plugins = Array.isArray(current.plugins) ? current.plugins.filter((v) => v !== href) : [];
    plugins.push(href);
    writeJson(file, { ...current, plugins });
    return [{ argv: ['opencode-cli.json', href], status: 0, ms: 0, stdout: href, stderr: '', host: 'opencode' }];
  }
  // Codex: never a PATH shim. Users run `murmo codex`.
  return [{ argv: ['murmo', 'codex'], status: 0, ms: 0, stdout: 'murmo codex', stderr: '', host: 'codex' }];
}

export function alreadyRegistered(journal: Journal, name: string): boolean {
  return journal.hosts.some((h) => h.name === name && h.installed) && journal.results.some((r) => r.host === name);
}

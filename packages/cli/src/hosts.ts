// Official host registration. Never a `codex` shim (lesson 40). Claude
// marketplace is the local payload copy until phase 31 chooses the published
// source. Journal replay is the uninstall source of truth (docs/plan/27).

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

/**
 * OpenCode loads every folder in `<config>/plugins/` as a TUI plugin, apart
 * from `cli.json`. Murmo used to add itself to `cli.json`'s `plugins`, but
 * OpenCode decodes that file as a whole and ignores all of it when one key
 * has a shape it doesn't expect (a `"theme": "opencode"` string from the old
 * tui.json), which took Murmo with it; rewriting the file also dropped the
 * user's comments and key order. The link leaves the user's files alone.
 */
function linkOpenCodePlugin(layout: HomeLayout, payload: string): string {
  const folder = join(layout.dirs.opencode, 'plugins');
  const link = join(folder, PACKAGE_NAME);
  const target = resolve(payload);
  mkdirSync(folder, { recursive: true });
  let current: ReturnType<typeof lstatSync> | undefined;
  try {
    current = lstatSync(link);
  } catch {
    current = undefined;
  }
  if (current && !current.isSymbolicLink()) {
    throw new CliError(`OpenCode registration failed: ${link} already exists and is not Murmo's link`, {
      action: 'move it aside and re-run murmo setup',
    });
  }
  if (current && resolve(folder, readlinkSync(link)) === target) return link;
  const tmp = `${link}.${process.pid}.tmp`;
  symlinkSync(target, tmp, 'dir');
  renameSync(tmp, link);
  return link;
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
    const link = linkOpenCodePlugin(layout, payload);
    return [{ argv: ['opencode-plugin-link', link], status: 0, ms: 0, stdout: link, stderr: '', host: 'opencode' }];
  }
  // Codex: never a PATH shim. Users run `murmo codex`. Command hooks are the
  // opt-in events preview (12 of them); writing them at setup puts stock Codex
  // behind native "Hooks need review". Events stay off by default, `murmo hook`
  // fail-opens without a wrapper socket, and Murmo never ships bypass_hook_trust.
  return [{ argv: ['murmo', 'codex'], status: 0, ms: 0, stdout: 'murmo codex', stderr: '', host: 'codex' }];
}

export function codexHooksPayload(): Record<string, unknown> {
  const events = [
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PermissionRequest',
    'PreCompact',
    'PostCompact',
    'SubagentStart',
    'SubagentStop',
    'Stop',
    'Interrupt',
  ];
  const hooks: Record<string, unknown> = {};
  for (const event of events) {
    const timeout = event === 'SessionEnd' ? 3 : 5;
    hooks[event] = [
      {
        hooks: [
          {
            type: 'command',
            command: `murmo hook codex ${event}`,
            timeout,
          },
        ],
      },
    ];
  }
  return { hooks };
}

export function alreadyRegistered(journal: Journal, name: string): boolean {
  return journal.hosts.some((h) => h.name === name && h.installed) && journal.results.some((r) => r.host === name);
}

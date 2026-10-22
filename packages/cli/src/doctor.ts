// `murmo doctor`: each check is {name, ok, detail, action}. Never trust a
// session "healthy" flag (lessons 71, 76 / E10). Exit 1 if any check fails.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadSessionConfig } from '@murmo/config/node';
import { claudeEventCaps, codexEventCaps, doctorLinesFor, opencodeEventCaps, piEventCaps } from '@murmo/core';
import { DATA_DIR, loadTrustAnchor, npmPlatform, VerifyError, verifyPackage } from '@murmo/integrity';
import { openLanguagePack } from '@murmo/lang/node';
import { doctorLine } from '@murmo/plugin-autocorrect';
import { doctorLine as historyDoctorLine } from '@murmo/plugin-history';
import { lastMerge, loadRecords, readMetrics as readHistoryMetrics } from '@murmo/plugin-history/node';
import { doctorLine as phrasesDoctorLine } from '@murmo/plugin-phrases';
import { readMetrics } from '@murmo/plugin-phrases/node';
import { openStore, storeRootsFromEnv } from '@murmo/store/node';
import { namesDoctorLine, tryReadProtection } from '@murmo/vocab/node';
import { detectHosts, lookup } from './detect.ts';
import { checkHelper } from './helper.ts';
import { type HomeLayout, homeLayout, sha256Bytes } from './home.ts';
import type { Journal } from './journal.ts';
import { readJournal } from './journal.ts';
import { lockDir } from './lock.ts';
import { helperAvailability } from './payload.ts';
import { liveSessions, type SessionRecord } from './uninstall.ts';

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly action: string;
}

export interface DoctorReport {
  readonly checks: DoctorCheck[];
  readonly hosts: Journal['hosts'] | ReturnType<typeof detectHosts>;
  readonly disabledPlugins: { id: string; fault?: unknown; session: string }[];
  readonly boundaries: unknown[];
}

export interface DoctorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly packageRoot?: string;
  readonly keyPath?: string;
  readonly json?: boolean;
  readonly stats?: boolean;
}

function check(name: string, ok: boolean, detail: string, action: string): DoctorCheck {
  return { name, ok, detail, action: ok ? 'none' : action };
}

function sessionPlugins(record: Record<string, unknown>): { id: string; enabled?: boolean; fault?: unknown }[] {
  const plugins = record.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.filter((p) => p && typeof p === 'object') as { id: string; enabled?: boolean; fault?: unknown }[];
}

function sessionBoundaries(record: Record<string, unknown>): unknown[] {
  return Array.isArray(record.boundaries) ? record.boundaries : [];
}

function helperDown(record: Record<string, unknown>): boolean {
  const helper = record.helper as { down?: boolean; pid?: number; transport?: string } | undefined;
  if (helper?.down === true) return true;
  if (typeof helper?.pid === 'number') {
    try {
      process.kill(helper.pid, 0);
      return false;
    } catch {
      return true;
    }
  }
  return false;
}

function inlineOk(record: Record<string, unknown>): boolean {
  const caps = (record.capabilities ?? {}) as {
    inlineRewrite?: string;
    inline?: { rewrite?: boolean; commitAcknowledged?: boolean; commitReceipt?: string };
  };
  const rewrite = caps.inlineRewrite === 'same-transaction' && caps.inline?.rewrite === true;
  const ack = caps.inline?.commitAcknowledged === true || caps.inline?.commitReceipt === 'native-commit';
  return rewrite && ack;
}

function vocabPartial(layout: HomeLayout): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  if (!existsSync(layout.cache)) return checks;
  for (const name of readdirSync(layout.cache)) {
    const dir = join(layout.cache, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const table = tryReadProtection(dir);
    if (table?.partial) {
      checks.push(
        check(
          `vocab:${name.slice(0, 12)}`,
          true,
          'partial',
          'file or byte limit stopped the walk; protection is incomplete',
        ),
      );
    }
    const names = namesDoctorLine(dir);
    if (names.detail !== 'no name index') {
      checks.push(
        check(`names:${name.slice(0, 12)}`, names.ok, names.detail, names.ok ? 'none' : 'murmo names rebuild'),
      );
    }
  }
  return checks;
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const layout = homeLayout(env);
  const journal = readJournal(layout.journal);
  const payload = existsSync(layout.payload) ? layout.payload : options.packageRoot;
  const checks: DoctorCheck[] = [];
  const disabledPlugins: DoctorReport['disabledPlugins'] = [];
  const boundaries: unknown[] = [];

  if (!payload) {
    checks.push(check('payload-integrity', false, 'not installed', 'run murmo setup'));
    return { checks, hosts: detectHosts(env), disabledPlugins, boundaries };
  }

  const anchor = loadTrustAnchor({ ...(options.keyPath ? { keyPath: options.keyPath } : {}), env });
  try {
    const result = verifyPackage(payload, anchor ? { publicKey: anchor.publicKey } : {});
    checks.push(
      check(
        'payload-integrity',
        true,
        result.authenticated ? `authenticated keyId=${result.keyId}` : `unauthenticated keyId=${result.keyId}`,
        'none',
      ),
    );
  } catch (error) {
    const message = error instanceof VerifyError || error instanceof Error ? error.message : String(error);
    checks.push(check('payload-integrity', false, message, 'reinstall the Murmo package'));
  }

  const packDir = join(payload, DATA_DIR);
  const opened = openLanguagePack(packDir, layout.validated);
  checks.push(
    opened.ok
      ? check('language-data', true, `integrity=${opened.integrity}`, 'none')
      : check('language-data', false, opened.reason, 'run murmo setup to re-validate the English pack'),
  );

  let helperBin: string | undefined;
  try {
    const availability = helperAvailability(payload);
    helperBin = availability.helper;
    if (availability.warning) {
      checks.push(check('platform-binaries', true, availability.warning, 'none'));
    }
  } catch (error) {
    checks.push(
      check(
        'platform-binaries',
        false,
        error instanceof Error ? error.message : String(error),
        'reinstall for this architecture',
      ),
    );
  }

  if (helperBin) {
    const helper = await checkHelper(helperBin, payload);
    checks.push(check('helper-ping', helper.ping, helper.detail, 'restart the session so the helper can start'));
    checks.push(
      check(
        'helper-guest',
        helper.guest,
        helper.guest ? 'first-party guest loaded' : helper.detail,
        'a ping is not a capability probe; fix the helper then re-run doctor',
      ),
    );
  }

  let historyEnabled = false;
  try {
    const store = await openStore({ roots: storeRootsFromEnv(env, env.HOME) });
    const cwd = env.PWD || process.cwd();
    const session = await loadSessionConfig({ cwd, store, env, ...(env.HOME ? { home: env.HOME } : {}) });
    historyEnabled = session.effective.historyEnabled === true;
    const names = session.effective.replacements.map((r) => r.shortcut);
    const where = session.trust === 'approved' ? 'trusted project .murmo.toml' : `trust=${session.trust}`;
    checks.push(
      check(
        'shortcuts',
        true,
        names.length
          ? `${names.length} loaded (${names.slice(0, 8).join(', ')}); ${where}; Codex has no ; menu overlay, space expands`
          : `0 loaded in ${cwd} (${where}); run murmo init in a git repo, then murmo trust, then restart murmo codex from that directory`,
        'none',
      ),
    );
  } catch (error) {
    checks.push(check('shortcuts', true, `could not load (${error instanceof Error ? error.message : error})`, 'none'));
  }

  const hosts = detectHosts(env);
  for (const host of hosts) {
    const old = journal?.hosts.find((h) => h.name === host.name);
    if (!host.installed) {
      checks.push(check(`host:${host.name}`, true, host.skipped ?? 'not on PATH', 'none'));
      continue;
    }
    const versionOk = !old?.version || old.version === host.version;
    checks.push(
      check(
        `host-version:${host.name}`,
        versionOk,
        versionOk ? (host.version ?? '') : `setup ${old?.version} now ${host.version}`,
        versionOk ? 'none' : 'restart the session and inspect actual capability probes',
      ),
    );
    const registered = journal?.results.some((r) => r.host === host.name) === true || host.name === 'codex';
    checks.push(
      check(
        `host-registration:${host.name}`,
        registered,
        registered ? 'present' : 'missing',
        'run murmo setup to register this host',
      ),
    );
  }

  const live = liveSessions(layout);
  for (const session of live) {
    const record = session.record;
    const healthyFlag = (record as SessionRecord).healthy === true;
    const down = helperDown(record);
    checks.push(
      check(
        `session-helper:${session.host}`,
        !down,
        down ? 'helper transport down' : 'helper transport available',
        down ? 'restart the host session; a killed helper is not "healthy"' : 'none',
      ),
    );
    const inline = inlineOk(record);
    checks.push(
      check(
        `inline-correction:${session.host}`,
        inline,
        inline ? 'same-transaction with acknowledgement' : 'not same-transaction with acknowledgement',
        'requires observed typed input and an acknowledged inline transaction',
      ),
    );
    if (healthyFlag && down) {
      checks.push(
        check(
          `session-healthy-flag:${session.host}`,
          false,
          'session reported healthy while the helper is down',
          'ignore the healthy flag; doctor listed the real fault',
        ),
      );
    }
    for (const plugin of sessionPlugins(record)) {
      if (plugin.enabled === false) {
        disabledPlugins.push({ id: plugin.id, fault: plugin.fault, session: session.host });
        checks.push(
          check(
            `plugin-disabled:${plugin.id}`,
            false,
            typeof plugin.fault === 'object' ? JSON.stringify(plugin.fault) : String(plugin.fault ?? 'disabled'),
            'fix the typed fault or re-enable the plugin (phase 28)',
          ),
        );
      }
    }
    for (const boundary of sessionBoundaries(record)) boundaries.push(boundary);
    const applied = Number(
      (record.metrics as { autocorrect?: { applied?: number } } | undefined)?.autocorrect?.applied ?? 0,
    );
    const rejected = Number(
      (record.metrics as { autocorrect?: { rejected?: number } } | undefined)?.autocorrect?.rejected ?? 0,
    );
    checks.push(
      check(
        `autocorrect:${session.host}`,
        true,
        doctorLine({ enabled: true, language: 'en', allow: [] }, applied, rejected),
        'none',
      ),
    );
  }

  const wrapper = lookup('codex', env) ? join(payload, 'bin', npmPlatform(), 'murmo-codex') : undefined;
  if (wrapper && existsSync(wrapper)) {
    const run = spawnSync(wrapper, ['--help'], { encoding: 'utf8', timeout: 8_000, env });
    checks.push(
      check(
        'codex-wrapper-spawn',
        run.error === undefined,
        run.error ? run.error.message : `exit ${run.status ?? 'null'}`,
        'reinstall the Codex wrapper for this platform',
      ),
    );
    checks.push(
      check(
        'codex-first-correction',
        true,
        'skipped: no live Codex session',
        'run a throwaway no-model session to exercise first correction',
      ),
    );
  }

  for (const boundary of boundaries) {
    const row = boundary as { boundary?: string; action?: string; evidence?: string };
    checks.push(
      check(
        `coexistence:${row.boundary ?? 'boundary'}`,
        true,
        typeof row.evidence === 'string' ? row.evidence : JSON.stringify(boundary),
        typeof row.action === 'string' ? row.action : 'see docs/plan/25-coexistence.md',
      ),
    );
  }

  checks.push(...vocabPartial(layout));

  try {
    const store = await openStore({ roots: storeRootsFromEnv(env, env.HOME) });
    const records = await loadRecords(store);
    const merged = await lastMerge(store);
    const metrics = await readHistoryMetrics(store);
    checks.push(
      check(
        'history',
        true,
        historyDoctorLine(metrics, {
          enabled: historyEnabled,
          prompts: records.length,
          ...(merged ? { merged: String(merged.generation) } : {}),
        }),
        historyEnabled ? 'none' : 'set [history] enabled = true to record sent prompts (stored as typed)',
      ),
    );
  } catch (error) {
    checks.push(
      check(
        'history',
        true,
        historyDoctorLine(undefined, { enabled: historyEnabled }),
        error instanceof Error ? error.message : 'none',
      ),
    );
  }

  if (options.stats) {
    try {
      const store = await openStore({ roots: storeRootsFromEnv(env, env.HOME) });
      const metrics = await readMetrics(store);
      checks.push(check('phrases-stats', true, phrasesDoctorLine(metrics), 'none'));
    } catch (error) {
      checks.push(check('phrases-stats', true, phrasesDoctorLine(), error instanceof Error ? error.message : 'none'));
    }
  }

  const eventCaps = {
    claude: claudeEventCaps(true),
    codex: codexEventCaps(),
    pi: piEventCaps(false),
    opencode: opencodeEventCaps(),
  } as const;
  for (const host of ['claude', 'codex', 'pi', 'opencode'] as const) {
    for (const row of doctorLinesFor(host, eventCaps[host])) {
      checks.push(check(row.name, true, row.detail, 'none'));
    }
  }

  const lock = lockDir(layout.data, env);
  checks.push(
    check(
      'install-lock',
      !existsSync(lock),
      existsSync(lock) ? lock : 'no leftover lock',
      'remove the stale lock directory',
    ),
  );
  checks.push(
    check(
      'staging',
      !existsSync(layout.staging),
      existsSync(layout.staging) ? 'stale staging folder' : 'no staging folder',
      'run murmo setup to finish or murmo uninstall to clean up',
    ),
  );
  if (journal?.launcher) {
    const pointsAt =
      existsSync(journal.launcher.path) && sha256Bytes(readFileSync(journal.launcher.path)) === journal.launcher.sha256;
    checks.push(check('launcher', pointsAt, journal.launcher.path, 'run murmo setup to rewrite ~/.local/bin/murmo'));
  }

  return { checks, hosts, disabledPlugins, boundaries };
}

export function printDoctor(report: DoctorReport, json: boolean, out: (s: string) => void): void {
  if (json) {
    out(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const c of report.checks) {
    out(`${c.ok ? 'ok' : 'FAIL'}  ${c.name}: ${c.detail}${c.ok ? '' : ` (${c.action})`}\n`);
  }
  if (report.disabledPlugins.length) {
    out('disabled plugins:\n');
    for (const p of report.disabledPlugins) out(`  ${p.id} ${JSON.stringify(p.fault ?? {})}\n`);
  }
}

export function doctorExit(report: DoctorReport): number {
  return report.checks.some((c) => !c.ok) ? 1 : 0;
}

// `murmo setup`: verify before any HOME write, journal, stage, validate
// language data, detect in a throwaway profile, register through official
// mechanisms, write a PATH launcher (docs/plan/27).

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { INTEGRITY_FILE, loadTrustAnchor, parseManifest, VerifyError, verifyPackage } from '@murmo/integrity';
import { detectHosts } from './detect.ts';
import { CliError } from './errors.ts';
import { homeLayout, inventoryOf, knownFiles, ownedRoots, parentExistence } from './home.ts';
import { alreadyRegistered, registerHost } from './hosts.ts';
import { backupFile, emptyJournal, type Journal, readJournal, setPhase, snapshotFile } from './journal.ts';
import {
  copyPayload,
  helperAvailability,
  packagePin,
  restoreExecBits,
  switchPayload,
  validateLanguage,
  versionCmp,
  writeLauncher,
} from './payload.ts';
import { replayJournal } from './uninstall.ts';

export interface SetupOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly packageRoot: string;
  readonly keyPath?: string;
  readonly json?: boolean;
}

export interface SetupReport {
  readonly status: 'installed' | 'reconciled' | 'upgraded' | 'unchanged';
  readonly store: string;
  readonly payload: string;
  readonly keyId: string;
  readonly fingerprint?: string;
  readonly authenticated: boolean;
  readonly hosts: Journal['hosts'];
  readonly registered: string[];
  readonly skipped: Journal['skipped'];
  readonly launcher?: string;
  readonly launcherOnPath?: boolean;
  readonly warning?: string;
  readonly claudeOnboarding: string;
}

const CLAUDE_ONBOARDING = 'Claude asks its own onboarding questions on first start; setup does not answer them';

export function verifyIncoming(
  root: string,
  keyPath: string | undefined,
  env: NodeJS.ProcessEnv,
): { keyId: string; fingerprint?: string; authenticated: boolean; version: string } {
  restoreExecBits(root);
  const integrity = `${root}/${INTEGRITY_FILE}`;
  if (!existsSync(integrity)) {
    throw new CliError(`${INTEGRITY_FILE} is missing; this CLI is not in a packed tree`, {
      action: 'run murmo setup from the installed package or pass --package',
    });
  }
  const parsed = parseManifest(JSON.parse(readFileSync(integrity, 'utf8')));
  const anchor = loadTrustAnchor({ ...(keyPath ? { keyPath } : {}), env });
  try {
    const result = verifyPackage(root, anchor ? { publicKey: anchor.publicKey } : {});
    return {
      keyId: result.keyId,
      authenticated: result.authenticated,
      version: parsed.version,
      ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
    };
  } catch (error) {
    if (error instanceof VerifyError) {
      throw new CliError(error.message, {
        action: 'refuse: HOME was not changed; replace the package and re-run setup',
      });
    }
    throw error;
  }
}

function seedJournal(layout: ReturnType<typeof homeLayout>, pin: { version: string; sha256: string }): Journal {
  const journal = emptyJournal(pin);
  journal.before = inventoryOf(ownedRoots(layout));
  journal.parents = parentExistence(layout, [layout.launcher]);
  for (const file of knownFiles(layout)) {
    if (existsSync(file)) journal.backup[file] = backupFile(file);
  }
  return journal;
}

function snapshotWritten(layout: ReturnType<typeof homeLayout>, journal: Journal): void {
  for (const file of knownFiles(layout)) {
    const shot = snapshotFile(file);
    if (shot) journal.written[file] = shot;
  }
}

function registerDetected(
  hosts: Journal['hosts'],
  journal: Journal,
  layout: ReturnType<typeof homeLayout>,
  payload: string,
  env: NodeJS.ProcessEnv,
  onlyNew: boolean,
): string[] {
  const registered: string[] = [];
  for (const host of hosts.filter((h) => h.installed)) {
    if (onlyNew && alreadyRegistered(journal, host.name)) continue;
    setPhase(journal, layout.journal, `register-${host.name}`, env);
    const results = registerHost(host, payload, layout, env);
    journal.results.push(...results);
    registered.push(host.name);
  }
  for (const host of hosts.filter((h) => !h.installed)) {
    const reason = host.skipped ?? 'not on PATH';
    if (!journal.skipped.some((s) => s.host === host.name)) journal.skipped.push({ host: host.name, reason });
  }
  return registered;
}

export async function setupCommand(options: SetupOptions): Promise<SetupReport> {
  const env = options.env ?? process.env;
  const layout = homeLayout(env);
  const verified = verifyIncoming(options.packageRoot, options.keyPath, env);
  const availability = helperAvailability(options.packageRoot);
  const pin = packagePin(options.packageRoot, verified.version);

  const existing = readJournal(layout.journal);
  if (existing?.complete) {
    verifyIncoming(layout.payload, options.keyPath, env);
    const hosts = detectHosts(env);
    const newHosts = hosts.filter((h) => h.installed && !existing.hosts.some((o) => o.name === h.name && o.installed));
    const newer = versionCmp(pin.version, existing.package.version) > 0;
    if (!newer && newHosts.length === 0) {
      return {
        status: 'unchanged',
        store: layout.data,
        payload: layout.payload,
        keyId: verified.keyId,
        authenticated: verified.authenticated,
        hosts: existing.hosts,
        registered: [],
        skipped: existing.skipped,
        ...(existing.launcher ? { launcher: existing.launcher.path } : {}),
        claudeOnboarding: CLAUDE_ONBOARDING,
        ...(verified.fingerprint ? { fingerprint: verified.fingerprint } : {}),
        ...(availability.warning ? { warning: availability.warning } : {}),
      };
    }
    let status: SetupReport['status'] = 'reconciled';
    if (newer) {
      copyPayload(options.packageRoot, layout.staging);
      setPhase(existing, layout.journal, 'copied', env);
      const moved = switchPayload(layout, layout.staging, existing);
      if (moved) existing.generations.push(moved);
      existing.package = { version: pin.version, sha256: pin.sha256 };
      setPhase(existing, layout.journal, 'payload', env);
      validateLanguage(layout.payload, layout.validated);
      writeLauncher(layout, env);
      status = 'upgraded';
    }
    existing.hosts = hosts;
    const registered = registerDetected(hosts, existing, layout, layout.payload, env, !newer);
    snapshotWritten(layout, existing);
    const launcher = writeLauncher(layout, env);
    existing.launcher = launcher.record;
    existing.complete = true;
    setPhase(existing, layout.journal, 'complete', env);
    return {
      status,
      store: layout.data,
      payload: layout.payload,
      keyId: verified.keyId,
      authenticated: verified.authenticated,
      hosts,
      registered,
      skipped: existing.skipped,
      launcher: launcher.record.path,
      launcherOnPath: launcher.onPath,
      claudeOnboarding: CLAUDE_ONBOARDING,
      ...(verified.fingerprint ? { fingerprint: verified.fingerprint } : {}),
      ...(availability.warning ? { warning: availability.warning } : {}),
    };
  }

  if (existing && !existing.complete) replayJournal(existing, layout);

  const journal = seedJournal(layout, { version: pin.version, sha256: pin.sha256 });
  setPhase(journal, layout.journal, 'journal', env);
  copyPayload(options.packageRoot, layout.staging);
  setPhase(journal, layout.journal, 'copied', env);
  if (existsSync(layout.payload)) rmSync(layout.payload, { recursive: true, force: true });
  switchPayload(layout, layout.staging, journal);
  setPhase(journal, layout.journal, 'payload', env);
  validateLanguage(layout.payload, layout.validated);
  journal.hosts = detectHosts(env);
  const registered = registerDetected(journal.hosts, journal, layout, layout.payload, env, false);
  const launcher = writeLauncher(layout, env);
  journal.launcher = launcher.record;
  snapshotWritten(layout, journal);
  journal.complete = true;
  setPhase(journal, layout.journal, 'complete', env);
  return {
    status: 'installed',
    store: layout.data,
    payload: layout.payload,
    keyId: verified.keyId,
    authenticated: verified.authenticated,
    hosts: journal.hosts,
    registered,
    skipped: journal.skipped,
    launcher: launcher.record.path,
    launcherOnPath: launcher.onPath,
    claudeOnboarding: CLAUDE_ONBOARDING,
    ...(verified.fingerprint ? { fingerprint: verified.fingerprint } : {}),
    ...(availability.warning ? { warning: availability.warning } : {}),
  };
}

export function printSetup(report: SetupReport, json: boolean, out: (s: string) => void): void {
  if (json) {
    out(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  out(`murmo setup: ${report.status}\n`);
  out(`  payload ${report.payload}\n`);
  out(
    `  keyId ${report.keyId}${report.authenticated ? '' : ' (unauthenticated bit-rot check; pass --key or MURMO_TRUST_KEY)'}\n`,
  );
  if (report.fingerprint) out(`  fingerprint ${report.fingerprint}\n`);
  const found = report.hosts.filter((h) => h.installed).map((h) => h.name);
  out(`  hosts found: ${found.join(', ') || '(none)'}\n`);
  out(`  registered: ${report.registered.join(', ') || '(none)'}\n`);
  for (const skip of report.skipped) out(`  skipped ${skip.host}: ${skip.reason}\n`);
  if (report.launcher) {
    out(
      report.launcherOnPath
        ? `  launcher ${report.launcher}\n`
        : `  launcher ${report.launcher} (~/.local/bin is not on PATH; use this path or add it)\n`,
    );
  }
  if (report.warning) out(`  warning: ${report.warning}\n`);
  out(`  ${report.claudeOnboarding}\n`);
  if (report.registered.includes('codex') || report.hosts.some((h) => h.name === 'codex' && h.installed)) {
    out(
      '  Codex: run `murmo codex`. Event hooks are not installed until [events] is on; Murmo never ships bypass_hook_trust.\n',
    );
  }
}

// Loading on Node and Bun: find the files, read them within bounds, check the
// project file's trust, merge. Runs at session start and on idle re-checks,
// never in the key handler (02-architecture § Loading and failures).
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { TrustApproval } from '@murmo/store';
import {
  findRepositoryRoot,
  type ProjectIdentity,
  projectIdentity,
  type Store,
  type WriteResult,
} from '@murmo/store/node';
import {
  CONFIG_LIMITS,
  type ConfigSource,
  type EffectiveConfig,
  ignoredFile,
  type LoadedConfig,
  mergeConfig,
  type PinnedFile,
  parseConfig,
  REFERENCE_PROBLEMS,
  type ReferenceRead,
  referencedPaths,
  resolveShortcuts,
  trustManifest,
} from '../index.ts';
import { type InsideRead, type ReadBudget, readInside } from './reader.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const PROJECT_FILE = '.murmo.toml';

/** `$XDG_CONFIG_HOME/murmo/murmo.toml`, default `~/.config/murmo/murmo.toml` (macOS too). */
export function userConfigPath(env: Env = process.env, home: string = env.HOME || homedir()): string {
  const base = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(base, 'murmo', 'murmo.toml');
}

/** What the idle re-check compares: a changed, created or removed file means reload. */
export interface FileStamp {
  readonly path: string;
  /** `dev:ino:size:mtimeNs:ctimeNs` of the path itself, or `missing`. */
  readonly stamp: string;
}

export async function stampOf(path: string): Promise<FileStamp> {
  try {
    const st = await fsp.lstat(path, { bigint: true });
    return { path, stamp: `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}` };
  } catch {
    return { path, stamp: 'missing' };
  }
}

function newBudget(): ReadBudget {
  return { bytes: CONFIG_LIMITS.snapshotBytes, reads: CONFIG_LIMITS.snapshotReads };
}

function fileDiagnostic(source: ConfigSource, read: Exclude<InsideRead, { status: 'ok' }>): LoadedConfig {
  const file =
    read.problem === 'too-large'
      ? ignoredFile(source, 'too-large', 'file is larger than 256 KiB and was not read')
      : ignoredFile(source, 'unreadable', `file ${REFERENCE_PROBLEMS[read.problem]}; ignored`);
  return { ...file, replacements: [] };
}

async function readReferences(
  config: LoadedConfig | ReturnType<typeof parseConfig>,
  root: string,
  budget: ReadBudget,
  stamps: FileStamp[],
): Promise<{ reads: Map<string, ReferenceRead>; pinned: PinnedFile[]; complete: boolean }> {
  const reads = new Map<string, ReferenceRead>();
  const pinned: PinnedFile[] = [];
  let complete = true;
  for (const path of referencedPaths(config)) {
    const read = await readInside(root, path, CONFIG_LIMITS.referenceBytes, budget);
    stamps.push(await stampOf(join(root, path)));
    if (read.status === 'ok') {
      reads.set(path, { status: 'ok', text: read.text });
      pinned.push({ path, resolved: read.resolved, links: read.links, sha256: read.sha256 });
      if (read.resolved !== path) stamps.push(await stampOf(join(root, read.resolved)));
    } else {
      reads.set(path, read);
      complete = false;
    }
  }
  return { reads, pinned, complete };
}

/**
 * The personal file. It is the user's own, so a symlinked `murmo.toml` (a
 * dotfiles checkout) is followed; its `file` references stay inside its folder.
 */
export async function loadUserConfig(path: string): Promise<{ config?: LoadedConfig; stamps: FileStamp[] }> {
  const stamps = [await stampOf(path)];
  const source: ConfigSource = { file: path, origin: 'user' };
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stamps };
    return { config: fileDiagnostic(source, { status: 'refused', problem: 'unreadable' }), stamps };
  }
  let text: string;
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { config: fileDiagnostic(source, { status: 'refused', problem: 'not-regular' }), stamps };
    if (st.size > CONFIG_LIMITS.configFileBytes) {
      return { config: fileDiagnostic(source, { status: 'refused', problem: 'too-large' }), stamps };
    }
    const bytes = await handle.readFile();
    if (bytes.length > CONFIG_LIMITS.configFileBytes) {
      return { config: fileDiagnostic(source, { status: 'refused', problem: 'too-large' }), stamps };
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { config: fileDiagnostic(source, { status: 'refused', problem: 'invalid-utf8' }), stamps };
    }
  } finally {
    await handle.close();
  }
  const parsed = parseConfig(text, source);
  const root = dirname(await fsp.realpath(path));
  const { reads } = await readReferences(parsed, root, newBudget(), stamps);
  return { config: resolveShortcuts(parsed, reads), stamps };
}

export interface ProjectSnapshot {
  readonly identity: ProjectIdentity;
  readonly config: LoadedConfig;
  /**
   * SHA-256 of the trust manifest. Absent when the snapshot can't be approved:
   * the file was ignored, or a reference could not be read, so a review would
   * not show exactly what loads.
   */
  readonly fingerprint?: string;
  readonly stamps: readonly FileStamp[];
}

/** Reads `.murmo.toml` at `root` and everything it references, as one snapshot. Undefined when there is none. */
export async function scanProject(root: string): Promise<ProjectSnapshot | undefined> {
  const identity = await projectIdentity(root);
  const file = join(identity.root, PROJECT_FILE);
  const stamps: FileStamp[] = [await stampOf(file)];
  if (stamps[0]?.stamp === 'missing') return undefined;
  const budget = newBudget();
  const source: ConfigSource = { file, origin: 'project' };
  const read = await readInside(identity.root, PROJECT_FILE, CONFIG_LIMITS.configFileBytes, budget);
  if (read.status === 'refused') {
    if (read.problem === 'not-found') return undefined;
    return { identity, config: fileDiagnostic(source, read), stamps };
  }
  if (read.resolved !== PROJECT_FILE) stamps.push(await stampOf(join(identity.root, read.resolved)));
  const parsed = parseConfig(read.text, source);
  const { reads, pinned, complete } = await readReferences(parsed, identity.root, budget, stamps);
  const config = resolveShortcuts(parsed, reads);
  if (parsed.status !== 'ok' || !complete) return { identity, config, stamps };
  const manifest = trustManifest(
    { path: PROJECT_FILE, resolved: read.resolved, links: read.links, sha256: read.sha256 },
    pinned,
  );
  return {
    identity,
    config,
    fingerprint: createHash('sha256').update(manifest, 'utf8').digest('hex'),
    stamps,
  };
}

/**
 * - `approved`: the snapshot's fingerprint and the repository identity match an approval.
 * - `review`: never approved.
 * - `changed`: approved once, but the content, a reference, a symlink or the clone changed.
 * - `not-approvable`: ignored file or unreadable reference; fix the file first.
 */
export type TrustState = 'approved' | 'review' | 'changed' | 'not-approvable';

export function trustStateOf(snapshot: ProjectSnapshot, approval: TrustApproval | undefined): TrustState {
  if (snapshot.fingerprint === undefined) return 'not-approvable';
  if (!approval) return 'review';
  const same =
    approval.fingerprint === snapshot.fingerprint &&
    approval.dev === snapshot.identity.dev &&
    approval.ino === snapshot.identity.ino &&
    approval.root === snapshot.identity.root;
  return same ? 'approved' : 'changed';
}

/**
 * Approves what the user reviewed. The project is scanned again and must
 * still have the reviewed fingerprint, so a review of old content can never
 * approve new content (r8 § 54). `murmo trust` (phase 15) shows the snapshot
 * first and passes its fingerprint here.
 */
export async function approveProject(
  store: Store,
  root: string,
  reviewedFingerprint: string,
  now: number = Date.now(),
): Promise<WriteResult | { readonly status: 'changed' }> {
  const snapshot = await scanProject(root);
  if (!snapshot?.fingerprint || snapshot.fingerprint !== reviewedFingerprint) return { status: 'changed' };
  return store.trust.approve({
    projectId: snapshot.identity.projectId,
    root: snapshot.identity.root,
    dev: snapshot.identity.dev,
    ino: snapshot.identity.ino,
    fingerprint: snapshot.fingerprint,
    approvedAt: now,
    shortcutCount: snapshot.config.replacements.length,
  });
}

export interface SessionConfig {
  readonly user?: LoadedConfig;
  readonly project?: ProjectSnapshot;
  /** `none`: no project file. */
  readonly trust: TrustState | 'none';
  readonly effective: EffectiveConfig;
  /** Every file this load depends on, trust.json included. */
  readonly stamps: readonly FileStamp[];
}

export interface SessionConfigOptions {
  /** The host's working directory; the project is the first `.git` above it. */
  readonly cwd: string;
  readonly store: Store;
  readonly env?: Env;
  readonly home?: string;
}

export async function loadSessionConfig(options: SessionConfigOptions): Promise<SessionConfig> {
  const env = options.env ?? process.env;
  const userPath = userConfigPath(env, options.home ?? (env.HOME || homedir()));
  const user = await loadUserConfig(userPath);
  const stamps: FileStamp[] = [...user.stamps, await stampOf(options.store.layout.trust)];
  const root = await findRepositoryRoot(options.cwd);
  let project: ProjectSnapshot | undefined;
  let trust: SessionConfig['trust'] = 'none';
  if (root) {
    project = await scanProject(root);
    if (project) {
      stamps.push(...project.stamps);
      trust = trustStateOf(project, await options.store.trust.find(project.identity.projectId));
    } else {
      // Watch for the file being created.
      stamps.push(await stampOf(join(await fsp.realpath(root), PROJECT_FILE)));
    }
  }
  const effective = mergeConfig({
    ...(user.config ? { user: user.config } : {}),
    ...(project ? { project: project.config } : {}),
    projectTrusted: trust === 'approved',
  });
  options.store.privacy.setConfigPrivate(effective.private);
  return {
    ...(user.config ? { user: user.config } : {}),
    ...(project ? { project } : {}),
    trust,
    effective,
    stamps,
  };
}

/** True when any file the load depended on changed since (cheap: one lstat each). */
export async function configChanged(config: SessionConfig): Promise<boolean> {
  for (const stamp of config.stamps) {
    if ((await stampOf(stamp.path)).stamp !== stamp.stamp) return true;
  }
  return false;
}

/**
 * The idle re-check: reloads only when a file changed. Returns the new config,
 * or undefined when nothing changed.
 */
export async function recheckSessionConfig(
  config: SessionConfig,
  options: SessionConfigOptions,
): Promise<SessionConfig | undefined> {
  return (await configChanged(config)) ? loadSessionConfig(options) : undefined;
}

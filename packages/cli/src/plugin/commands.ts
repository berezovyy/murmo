import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { API_VERSION } from '@murmo/api';
import {
  assertApiCompatible,
  type InspectedPlugin,
  type SignedRevocation,
  type SignedRotation,
  verifyRevocation,
  verifyRotation,
} from '@murmo/integrity';
import { extensionsDir, pluginCacheFile, pluginRecordPath, type StoreRoots, storeLayout } from '@murmo/store';
import {
  BUILTIN_IDS,
  bumpManifest,
  chainPrevious,
  clearJournal,
  type InstalledPlugin,
  initPluginStore,
  listLiveSessions,
  type PluginsManifest,
  readLastRollback,
  readLedger,
  readPluginsManifest,
  recoverInterrupted,
  referencedDigests,
  removeGenerationFiles,
  removePluginTrees,
  waitForRevision,
  writeJournal,
  writeLastRollback,
  writeLedger,
} from '@murmo/store/node';
import { inspectArchive } from './archive.ts';
import { flagString, parsePluginArgs } from './args.ts';
import { fail } from './errors.ts';
import { grantReview, HIGH_TRUST, parseGrantList, requireGrants } from './grants.ts';
import { migrateStorage, preflightActivate } from './preflight.ts';
import { reviewProjectFile } from './project.ts';
import { type ResolveOptions, resolveSource } from './sources.ts';
import {
  assertPins,
  assertPublisherGate,
  assertTrust,
  FIRST_PARTY_PUBLISHER,
  fingerprintFromKeyFile,
  isRevoked,
  nextIdentity,
  type TrustGate,
} from './trust.ts';
import { verifyInstalled } from './verify.ts';

export const PLUGIN_USAGE = `murmo plugin
  murmo plugin list [--json]
  murmo plugin inspect <source> [--registry URL] [--json]
  murmo plugin add <source> --trust-key PUBLIC.pem --grant <list> [--digest HEX] [--registry URL] [--rotate-statement FILE]
  murmo plugin update <source> [--grant <list>] [--digest HEX] [--registry URL] [--rotate-statement FILE]
  murmo plugin disable|enable|remove|rollback|reinstall <id>
  murmo plugin revoke --statement FILE --trust-key PUBLIC.pem
  murmo plugin doctor [--json]
  murmo plugin project-review <file>
  murmo plugin project-apply <file> --approve-project HEX
`;

export interface PluginCommandContext {
  readonly roots: StoreRoots;
  readonly cwd: string;
  readonly packed: boolean;
  readonly firstPartyFingerprint?: string;
  readonly allowThirdParty?: boolean;
  readonly get?: ResolveOptions['get'];
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly now?: () => number;
  readonly quiesceMs?: number;
}

function gateOf(ctx: PluginCommandContext): TrustGate {
  return {
    firstPartyFingerprint: ctx.firstPartyFingerprint ?? FIRST_PARTY_PUBLISHER,
    // Phase 32: packed trees accept independently supplied publisher keys.
    allowThirdParty: ctx.allowThirdParty ?? true,
  };
}

function print(ctx: PluginCommandContext, json: boolean, value: unknown, text: string): number {
  ctx.out(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
  return 0;
}

async function requireManifest(ctx: PluginCommandContext): Promise<PluginsManifest> {
  await recoverInterrupted(ctx.roots);
  const manifest = await readPluginsManifest(ctx.roots);
  if (!manifest) fail('platform-not-installed');
  return manifest;
}

function pluginOf(manifest: PluginsManifest, id: string): InstalledPlugin {
  const plugin = manifest.plugins[id];
  if (!plugin) fail('distributed-plugin-absent', { id });
  return plugin;
}

function putPlugin(manifest: PluginsManifest, id: string, plugin: InstalledPlugin): PluginsManifest {
  return { ...manifest, plugins: { ...manifest.plugins, [id]: plugin } };
}

async function writeGeneration(roots: StoreRoots, inspected: InspectedPlugin): Promise<string> {
  const dest = extensionsDir(roots, inspected.envelope.id, inspected.digest);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const [rel, bytes] of Object.entries(inspected.files)) {
    const path = join(dest, rel);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
  }
  return dest;
}

async function snapshotLiveStorage(roots: StoreRoots, id: string): Promise<Record<string, unknown>> {
  const layout = storeLayout(roots);
  const { readFile } = await import('node:fs/promises');
  try {
    const raw = await readFile(pluginRecordPath(layout, id), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed) {
      const data = (parsed as { data: unknown }).data;
      if (data && typeof data === 'object' && !Array.isArray(data)) return { ...(data as Record<string, unknown>) };
    }
  } catch {
    // no live namespace yet
  }
  return {};
}

async function writeLiveStorage(roots: StoreRoots, id: string, data: Record<string, unknown>): Promise<void> {
  const { writeAtomic, ensurePrivateDir } = await import('@murmo/store/node');
  const layout = storeLayout(roots);
  const path = pluginRecordPath(layout, id);
  await ensurePrivateDir(dirname(path), roots.data);
  await writeAtomic(path, `${JSON.stringify({ schema: 1, plugin: id, data })}\n`);
}

export async function pluginCommand(ctx: PluginCommandContext, args: readonly string[]): Promise<number> {
  const parsed = parsePluginArgs(args);
  const json = parsed.flags.has('--json');
  const [command, ...rest] = parsed.positional;
  if (!command || command === 'help' || command === '-h') {
    ctx.out(PLUGIN_USAGE);
    return command ? 0 : 2;
  }

  if (command === 'inspect') {
    const source = rest[0];
    if (!source) {
      ctx.err('usage: murmo plugin inspect <source>\n');
      return 2;
    }
    const resolved = await resolveSource(source, {
      registry: flagString(parsed.flags, '--registry'),
      get: ctx.get,
    });
    const inspected = inspectArchive(resolved.bytes);
    const review = grantReview(inspected);
    return print(
      ctx,
      json,
      { status: 'review', ...review, manifest: inspected.envelope },
      [
        `${review.id}@${inspected.envelope.version}`,
        `digest ${review.digest}`,
        `publisher ${review.publisher}`,
        ...review.permissions.map((p) => `  ${p.name}: ${p.reason}`),
      ].join('\n'),
    );
  }

  if (command === 'project-review' || command === 'project-apply') {
    const file = rest[0];
    if (!file) {
      ctx.err(`usage: murmo plugin ${command} <file>\n`);
      return 2;
    }
    const review = reviewProjectFile(file);
    if (command === 'project-review') {
      return print(
        ctx,
        json,
        review,
        [
          `project ${review.project}`,
          `digest ${review.digest}`,
          ...review.requests.map((r) => `  ${r.id} ${r.digest}`),
          review.warning,
        ].join('\n'),
      );
    }
    const approve = flagString(parsed.flags, '--approve-project');
    if (approve !== review.digest)
      fail('project-approval-required', { project: review.project, digest: review.digest, requests: review.requests });
    await recoverInterrupted(ctx.roots);
    const ledger = await readLedger(ctx.roots);
    await writeLedger(ctx.roots, {
      ...ledger,
      projects: { ...ledger.projects, [review.project]: { digest: review.digest, requests: [...review.requests] } },
    });
    return print(
      ctx,
      json,
      {
        status: 'project-approved-no-code-installed',
        project: review.project,
        digest: review.digest,
        requests: review.requests,
      },
      `approved ${review.project} (no code installed)`,
    );
  }

  if (command === 'list') {
    const manifest = await requireManifest(ctx);
    const rows = manifest.order.map((id) => {
      const plugin = manifest.plugins[id];
      return {
        id,
        enabled: plugin?.enabled !== false,
        builtin: plugin?.builtin === true,
        version: plugin?.distribution?.manifest.version,
        digest: plugin?.distribution?.digest,
        publisher: plugin?.distribution?.publisher,
        grants: plugin?.grants ?? [],
        highTrust: (plugin?.grants ?? []).filter((g) => (HIGH_TRUST as readonly string[]).includes(g)),
      };
    });
    return print(
      ctx,
      json,
      { revision: manifest.revision, plugins: rows },
      rows
        .map((r) => {
          const extra = r.highTrust.length ? ` high-trust:${r.highTrust.join(',')}` : '';
          return `${r.enabled ? 'on ' : 'off'} ${r.id}${r.builtin ? ' (builtin)' : r.version ? ` ${r.version}` : ''}${extra}`;
        })
        .join('\n') || 'no plugins',
    );
  }

  if (command === 'doctor') {
    const manifest = await requireManifest(ctx);
    const plugins = Object.entries(manifest.plugins).map(([id, plugin]) => {
      try {
        if (plugin.distribution) verifyInstalled(ctx.roots, plugin);
        return {
          id,
          ok: true,
          version: plugin.distribution?.manifest.version,
          api: plugin.distribution?.manifest.api,
          publisher: plugin.distribution?.publisher,
          digest: plugin.distribution?.digest,
          grants: plugin.grants,
          storageVersion: plugin.distribution?.manifest.storageVersion,
          enabled: plugin.enabled,
          builtin: plugin.builtin === true,
        };
      } catch (error) {
        return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    const last = await readLastRollback(ctx.roots);
    const ledger = await readLedger(ctx.roots);
    const revoked = plugins.filter((p) => {
      if (!p.ok || !p.publisher || typeof p.publisher !== 'string') return false;
      return isRevoked(ledger.revocations, p.id, p.publisher, typeof p.version === 'string' ? p.version : undefined);
    });
    for (const row of revoked) {
      const plugin = manifest.plugins[row.id];
      if (plugin?.previous?.distribution) {
        (row as { ok: boolean; error?: string }).ok = false;
        (row as { error?: string }).error = 'revoked; roll back to last good generation';
      } else {
        (row as { ok: boolean; error?: string }).ok = false;
        (row as { error?: string }).error = 'revoked';
      }
    }
    const payload = {
      core: { apiVersion: API_VERSION },
      plugins,
      lastRollback: last ?? null,
      revocations: ledger.revocations ?? [],
    };
    const failed = plugins.filter((p) => !p.ok);
    const text = [`core ${API_VERSION}`, ...plugins.map((p) => (p.ok ? `ok ${p.id}` : `FAIL ${p.id} ${p.error}`))].join(
      '\n',
    );
    ctx.out(json ? `${JSON.stringify(payload, null, 2)}\n` : `${text}\n`);
    return failed.length ? 1 : 0;
  }

  if (command === 'add' || command === 'update') {
    return install(ctx, command, rest, parsed.flags, json);
  }

  if (command === 'revoke') {
    const statementPath = flagString(parsed.flags, '--statement');
    const keyPath = flagString(parsed.flags, '--trust-key');
    if (!statementPath || !keyPath) {
      ctx.err('usage: murmo plugin revoke --statement FILE --trust-key PUBLIC.pem\n');
      return 2;
    }
    const signed = JSON.parse(readFileSync(statementPath, 'utf8')) as SignedRevocation;
    const publisher = verifyRevocation(signed, readFileSync(keyPath));
    const ledger = await readLedger(ctx.roots);
    const record = {
      publisher,
      reason: signed.reason,
      issuedAt: signed.issuedAt,
      signature: signed.signature,
      ...(signed.plugin ? { plugin: signed.plugin } : {}),
      ...(signed.version ? { version: signed.version } : {}),
    };
    await writeLedger(ctx.roots, { ...ledger, revocations: [...(ledger.revocations ?? []), record] });
    return print(
      ctx,
      json,
      { status: 'revoked', ...record },
      `revoked ${publisher}${signed.version ? ` ${signed.version}` : ''}`,
    );
  }

  if (['remove', 'enable', 'disable', 'rollback', 'reinstall'].includes(command)) {
    const id = rest[0];
    if (!id) {
      ctx.err(`usage: murmo plugin ${command} <id>\n`);
      return 2;
    }
    return lifecycle(ctx, command, id, json);
  }

  ctx.err(`murmo plugin: unknown command ${command}\n${PLUGIN_USAGE}`);
  return 2;
}

async function lifecycle(ctx: PluginCommandContext, command: string, id: string, json: boolean): Promise<number> {
  let manifest = await requireManifest(ctx);
  const plugin = pluginOf(manifest, id);

  if (command === 'remove') {
    const { [id]: _removed, ...rest } = manifest.plugins;
    manifest = await bumpManifest(ctx.roots, {
      ...manifest,
      order: manifest.order.filter((item) => item !== id),
      plugins: rest,
    });
    await waitForRevision(ctx.roots, manifest.revision, ctx.quiesceMs);
    await removePluginTrees(ctx.roots, id);
    const layout = storeLayout(ctx.roots);
    const { rm } = await import('node:fs/promises');
    await rm(pluginRecordPath(layout, id), { force: true });
    return print(
      ctx,
      json,
      { status: 'removed', id, revision: manifest.revision, retained: 'publisher/high-water/digest metadata only' },
      `removed ${id}`,
    );
  }

  if (command === 'rollback') {
    if (!plugin.previous?.distribution) fail('last-good-absent', { id });
    verifyInstalled(ctx.roots, plugin.previous);
    const restored = plugin.previous;
    manifest = await bumpManifest(ctx.roots, putPlugin(manifest, id, restored));
    if (restored.storageFile) {
      const { readFile } = await import('node:fs/promises');
      try {
        const raw = await readFile(join(ctx.roots.data, restored.storageFile), 'utf8');
        await writeLiveStorage(ctx.roots, id, JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // snapshot missing: keep live storage
      }
    }
    await waitForRevision(ctx.roots, manifest.revision, ctx.quiesceMs);
    return print(
      ctx,
      json,
      { status: 'rolled-back', id, revision: manifest.revision, to: restored.distribution?.manifest.version },
      `rolled back ${id} to ${String(restored.distribution?.manifest.version)}`,
    );
  }

  if (command === 'reinstall') {
    if (!plugin.distribution) fail('distributed-plugin-absent', { id });
    const { readFileSync } = await import('node:fs');
    const cache = pluginCacheFile(ctx.roots, id, plugin.distribution.digest);
    const bytes = readFileSync(cache);
    const inspected = inspectArchive(bytes);
    if (inspected.digest !== plugin.distribution.digest) fail('cached-digest-mismatch', { id });
    await writeGeneration(ctx.roots, inspected);
    return print(
      ctx,
      json,
      { status: 'reinstalled-offline', id, digest: inspected.digest },
      `reinstalled ${id} offline`,
    );
  }

  if (
    plugin.distribution === undefined &&
    !plugin.builtin &&
    !BUILTIN_IDS.includes(id as (typeof BUILTIN_IDS)[number])
  ) {
    fail('distributed-plugin-absent', { id });
  }
  const enabled = command === 'enable';
  manifest = await bumpManifest(ctx.roots, putPlugin(manifest, id, { ...plugin, enabled }));
  await waitForRevision(ctx.roots, manifest.revision, ctx.quiesceMs);
  return print(ctx, json, { status: command, id, revision: manifest.revision }, `${command} ${id}`);
}

async function install(
  ctx: PluginCommandContext,
  command: 'add' | 'update',
  rest: string[],
  flags: Map<string, string | true>,
  json: boolean,
): Promise<number> {
  const source = rest[0];
  if (!source) {
    ctx.err(`usage: murmo plugin ${command} <source>\n`);
    return 2;
  }
  let manifest = await requireManifest(ctx);
  const ledger = await readLedger(ctx.roots);
  const resolved = await resolveSource(source, {
    registry: flagString(flags, '--registry'),
    offline: flags.has('--offline'),
    get: ctx.get,
  });
  const inspected = inspectArchive(resolved.bytes);
  const id = inspected.envelope.id;
  if ((BUILTIN_IDS as readonly string[]).includes(id)) fail('reserved-id', { id });
  const old = manifest.plugins[id];
  if (command === 'add' && old?.distribution) fail('already-installed', { id });
  if (command === 'update' && !old?.distribution) fail('distributed-plugin-absent', { id });
  assertApiCompatible(inspected.envelope.api, API_VERSION);
  const digestPin = flagString(flags, '--digest');
  if (digestPin && digestPin !== inspected.digest)
    fail('digest-pin-mismatch', { expected: digestPin, actual: inspected.digest });
  assertPublisherGate(inspected, gateOf(ctx));
  const identity = ledger.identities[id];
  if (isRevoked(ledger.revocations, id, inspected.publisher, inspected.envelope.version)) {
    fail('revoked', { id, publisher: inspected.publisher, version: inspected.envelope.version });
  }
  let rotationTo: string | undefined;
  const rotatePath = flagString(flags, '--rotate-statement');
  const trustKey = flagString(flags, '--trust-key');
  if (rotatePath) {
    if (!identity || !trustKey) fail('publisher-approval-required', { id, publisher: inspected.publisher });
    const signed = JSON.parse(readFileSync(rotatePath, 'utf8')) as SignedRotation;
    rotationTo = verifyRotation(signed, readFileSync(trustKey));
    if (signed.plugin !== id) fail('publisher-key-changed', { expected: id, actual: signed.plugin });
    if (fingerprintFromKeyFile(trustKey) !== identity.publisher) {
      fail('publisher-key-not-approved', { expected: identity.publisher, actual: fingerprintFromKeyFile(trustKey) });
    }
    if (rotationTo !== inspected.publisher) {
      fail('publisher-key-changed', { expected: rotationTo, actual: inspected.publisher });
    }
  }
  assertTrust(inspected, identity, trustKey, rotationTo);
  assertPins(inspected, identity, old?.distribution?.digest);
  if (old?.distribution?.digest === inspected.digest) {
    return print(
      ctx,
      json,
      {
        status: 'unchanged',
        id,
        version: inspected.envelope.version,
        digest: inspected.digest,
        revision: manifest.revision,
      },
      `unchanged ${id}`,
    );
  }
  const granted = parseGrantList(flagString(flags, '--grant'));
  requireGrants(inspected, granted, command === 'update' ? old?.grants : undefined);
  if (command === 'add' && !flagString(flags, '--grant') && inspected.envelope.permissions.length) {
    requireGrants(inspected, [], undefined);
  }

  const dest = extensionsDir(ctx.roots, id, inspected.digest);
  const storageRel = `plugin-storage/${id}/${inspected.digest}.json`;
  await writeJournal(ctx.roots, {
    schema: 1,
    op: command,
    id,
    phase: 'extract',
    toDigest: inspected.digest,
    ...(old?.distribution ? { fromDigest: old.distribution.digest, previousEnabled: old.enabled } : {}),
  });
  await writeGeneration(ctx.roots, inspected);

  const original = old ? structuredClone(old) : undefined;
  let quiesced = false;
  let committed = false;
  try {
    if (old?.distribution) {
      await writeJournal(ctx.roots, {
        schema: 1,
        op: command,
        id,
        phase: 'quiesce',
        toDigest: inspected.digest,
        fromDigest: old.distribution.digest,
        previousEnabled: old.enabled,
      });
      manifest = await bumpManifest(ctx.roots, putPlugin(manifest, id, { ...old, enabled: false }));
      quiesced = true;
      await waitForRevision(ctx.roots, manifest.revision, ctx.quiesceMs);
    }

    await writeJournal(ctx.roots, {
      schema: 1,
      op: command,
      id,
      phase: 'snapshot',
      toDigest: inspected.digest,
      ...(old?.distribution ? { fromDigest: old.distribution.digest, previousEnabled: old.enabled } : {}),
    });
    let data = old ? await snapshotLiveStorage(ctx.roots, id) : {};
    if (old?.distribution) {
      const fromVersion = Number(old.distribution.manifest.storageVersion ?? 1);
      data = migrateStorage(data, fromVersion, inspected.envelope);
    }

    await writeJournal(ctx.roots, {
      schema: 1,
      op: command,
      id,
      phase: 'preflight',
      toDigest: inspected.digest,
      ...(old?.distribution ? { fromDigest: old.distribution.digest, previousEnabled: old.enabled } : {}),
    });
    const entryPath = join(dest, inspected.envelope.entry);
    const activated = await preflightActivate(inspected, entryPath, data, inspected.envelope.permissions);
    data = activated.storage;
    const { writeAtomic, ensurePrivateDir } = await import('@murmo/store/node');
    await ensurePrivateDir(dirname(join(ctx.roots.data, storageRel)), ctx.roots.data);
    await writeAtomic(join(ctx.roots.data, storageRel), `${JSON.stringify(data)}\n`);
    await writeLiveStorage(ctx.roots, id, data);
    mkdirSync(dirname(pluginCacheFile(ctx.roots, id, inspected.digest)), { recursive: true, mode: 0o700 });
    writeFileSync(pluginCacheFile(ctx.roots, id, inspected.digest), resolved.bytes, { mode: 0o600 });

    const previous = old ? chainPrevious(old) : undefined;
    const candidate: InstalledPlugin = {
      enabled: old?.enabled ?? true,
      grants: [...inspected.envelope.permissions],
      storageFile: storageRel,
      entry: `${dest}/${inspected.envelope.entry}`,
      distribution: {
        digest: inspected.digest,
        publisher: inspected.publisher,
        manifest: { ...inspected.envelope },
        source: resolved.source,
      },
      ...(previous ? { previous } : {}),
    };

    const nextLedger = {
      ...ledger,
      identities: { ...ledger.identities, [id]: nextIdentity(inspected, identity) },
    };
    await writeLedger(ctx.roots, nextLedger);
    const order = manifest.order.includes(id) ? manifest.order : [...manifest.order, id];
    manifest = await bumpManifest(ctx.roots, { ...putPlugin(manifest, id, candidate), order });
    committed = true;
    await clearJournal(ctx.roots);

    const keep = referencedDigests(candidate);
    if (original?.distribution) {
      for (const digest of referencedDigests(original)) {
        if (!keep.has(digest)) await removeGenerationFiles(ctx.roots, id, digest);
      }
    }
    await waitForRevision(ctx.roots, manifest.revision, ctx.quiesceMs);
    const sessions = await listLiveSessions(ctx.roots);
    const failed = sessions.find((s) => s.ack.plugins[id] === 'error');
    if (failed && original) {
      manifest = await bumpManifest(ctx.roots, putPlugin(manifest, id, original));
      await writeLastRollback(ctx.roots, {
        id,
        failedDigest: inspected.digest,
        to: original.distribution?.digest ?? '',
        error: failed.ack.errors?.[id] ?? 'activation error',
        phase: 'activation',
        at: (ctx.now ?? Date.now)(),
      });
      fail('activation-failed', { error: failed.ack.errors?.[id] ?? 'host activation failed' });
    }
    return print(
      ctx,
      json,
      {
        status: command,
        id,
        version: inspected.envelope.version,
        digest: inspected.digest,
        publisher: inspected.publisher,
        grants: candidate.grants,
        revision: manifest.revision,
        source: resolved.source,
      },
      `${command} ${id}@${inspected.envelope.version}`,
    );
  } catch (error) {
    if (!committed) {
      if (quiesced && original) {
        await bumpManifest(ctx.roots, putPlugin(manifest, id, original));
        await writeLastRollback(ctx.roots, {
          id,
          failedDigest: inspected.digest,
          to: original.distribution?.digest ?? '',
          error: error instanceof Error ? error.message : String(error),
          phase: 'preflight',
          at: (ctx.now ?? Date.now)(),
        });
      }
      if (!old || inspected.digest !== old.distribution?.digest) {
        await removeGenerationFiles(ctx.roots, id, inspected.digest);
      }
      await clearJournal(ctx.roots);
    }
    throw error;
  }
}

export async function ensurePluginStore(roots: StoreRoots): Promise<void> {
  await initPluginStore(roots);
}

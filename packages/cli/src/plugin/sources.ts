// Resolve a plugin source to exact bytes. Pins only: exact npm version, full
// git commit, local tarball. Install scripts never run (E1).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARCHIVE_COMPRESSED_MAX } from '@murmo/integrity';
import type { PluginSource } from '@murmo/store/node';
import { fail } from './errors.ts';

const NPM_SPEC = /^npm:((?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*)@(\d+\.\d+\.\d+)$/;
const GIT_COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const FETCH_MS = 5000;

export interface SourceGet {
  get(url: URL): Promise<Uint8Array>;
}

export interface ResolveOptions {
  readonly registry?: string | undefined;
  readonly offline?: boolean | undefined;
  readonly get?: SourceGet['get'] | undefined;
}

export interface ResolvedSource {
  readonly bytes: Uint8Array;
  readonly source: PluginSource;
}

function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function defaultGet(url: URL): Promise<Uint8Array> {
  if (url.username || url.password) fail('fetch-failed', { url: url.href, reason: 'credentials' });
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('fetch-failed', { url: url.href });
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolveGet, reject) => {
    const req = send(url, { method: 'GET', timeout: FETCH_MS }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        reject(new Error(JSON.stringify({ code: 'fetch-failed', url: url.href, status: res.statusCode })));
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        reject(new Error(JSON.stringify({ code: 'fetch-failed', url: url.href, status: res.statusCode })));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > ARCHIVE_COMPRESSED_MAX) {
          req.destroy();
          reject(new Error(JSON.stringify({ code: 'download-too-large' })));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolveGet(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function getJson(get: SourceGet['get'], url: URL): Promise<Record<string, unknown>> {
  const bytes = await get(url);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    fail('fetch-failed', { url: url.href, reason: 'not-json' });
  }
  if (typeof value !== 'object' || value === null) fail('fetch-failed', { url: url.href });
  return value as Record<string, unknown>;
}

async function resolveNpm(spec: string, options: ResolveOptions): Promise<ResolvedSource> {
  const match = NPM_SPEC.exec(spec);
  if (!match) fail('npm-exact-version-required', { spec });
  if (options.offline) fail('offline-use-reinstall', { spec });
  const name = match[1] as string;
  const version = match[2] as string;
  const registry = (options.registry ?? 'http://127.0.0.1:4873').replace(/\/$/, '');
  const get = options.get ?? defaultGet;
  let registryUrl: URL;
  try {
    registryUrl = new URL(registry);
  } catch {
    fail('fetch-failed', { url: registry });
  }
  if (registryUrl.protocol !== 'http:' && registryUrl.protocol !== 'https:') {
    fail('fetch-failed', { url: registry });
  }
  const encoded = name.startsWith('@') ? name.replace('/', '%2f') : name;
  const meta = await getJson(get, new URL(`${registryUrl.href.replace(/\/$/, '')}/${encoded}/${version}`));
  const dist = meta.dist as { tarball?: unknown; integrity?: unknown } | undefined;
  if (typeof dist?.tarball !== 'string' || typeof dist.integrity !== 'string') {
    fail('fetch-failed', { spec, reason: 'missing-dist' });
  }
  const tarballUrl = new URL(dist.tarball);
  if (tarballUrl.protocol !== 'http:' && tarballUrl.protocol !== 'https:') fail('fetch-failed', { url: dist.tarball });
  const bytes = await get(tarballUrl);
  if (dist.integrity !== sha512Integrity(bytes)) {
    fail('registry-integrity-mismatch', { spec, expected: dist.integrity });
  }
  return {
    bytes,
    source: { kind: 'npm', spec, registry: registryUrl.href.replace(/\/$/, ''), integrity: dist.integrity },
  };
}

function resolveGit(spec: string): ResolvedSource {
  if (!spec.startsWith('git+')) fail('git-full-commit-required', { spec });
  let parsed: URL;
  try {
    parsed = new URL(spec.slice(4));
  } catch {
    fail('git-full-commit-required', { spec });
  }
  const commit = parsed.hash.replace(/^#/, '');
  parsed.hash = '';
  if (!GIT_COMMIT.test(commit)) fail('git-full-commit-required', { spec });
  if (parsed.protocol === 'file:') {
    const repo = parsed.pathname;
    let actual: string;
    try {
      actual = execFileSync('git', ['--git-dir', repo, 'rev-parse', `${commit}^{commit}`], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
    } catch {
      fail('git-pin-mismatch', { commit });
    }
    if (actual !== commit) fail('git-pin-mismatch', { expected: commit, actual });
    const bytes = execFileSync('git', ['--git-dir', repo, 'archive', '--format=tar', commit], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { bytes, source: { kind: 'git', spec, url: pathToFileURL(repo).href, commit } };
  }
  if (parsed.protocol !== 'https:') fail('git-full-commit-required', { spec });
  const remote = parsed.href;
  const bytes = execFileSync('git', ['archive', '--format=tar', `--remote=${remote}`, commit], {
    timeout: 8000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { bytes, source: { kind: 'git', spec, url: remote, commit } };
}

export async function resolveSource(spec: string, options: ResolveOptions = {}): Promise<ResolvedSource> {
  if (spec.startsWith('npm:')) return resolveNpm(spec, options);
  if (spec.startsWith('git+')) return resolveGit(spec);
  const path = resolve(spec);
  return { bytes: readFileSync(path), source: { kind: 'tarball', spec, path } };
}

export { sha512Integrity };

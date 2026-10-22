// Project `[[plugins]]` is a reviewed request list. Approval installs no code
// and grants no network (D6). Parsed with the core TOML parser, not a second
// grammar. A `[[plugins]]` example inside a multiline string is not a request.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseToml } from '@murmo/config';
import type { ProjectPluginRequest } from '@murmo/store/node';
import { fail } from './errors.ts';

const PROJECT_MAX_BYTES = 65_536;
const HEX64 = /^[0-9a-f]{64}$/;
const PLUGIN_ID = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]{0,63}$/;
const REQUEST_KEYS = new Set(['id', 'source', 'digest', 'publisher']);

export interface ProjectReview {
  readonly status: 'untrusted-project';
  readonly project: string;
  readonly digest: string;
  readonly requests: readonly ProjectPluginRequest[];
  readonly warning: string;
}

function asRequest(value: unknown, index: number): ProjectPluginRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('project-pin-required', { index });
  }
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (!REQUEST_KEYS.has(key)) fail('project-pin-required', { index, key });
  }
  const id = row.id;
  const source = row.source;
  const digest = row.digest;
  const publisher = row.publisher;
  if (typeof id !== 'string' || !PLUGIN_ID.test(id)) fail('project-pin-required', { index, field: 'id' });
  if (typeof source !== 'string' || !source) fail('project-pin-required', { index, field: 'source' });
  if (typeof digest !== 'string' || !HEX64.test(digest)) fail('project-pin-required', { index, field: 'digest' });
  if (typeof publisher !== 'string' || !HEX64.test(publisher))
    fail('project-pin-required', { index, field: 'publisher' });
  return { id, source, digest, publisher };
}

export function readProjectRequests(text: string): ProjectPluginRequest[] {
  const parsed = parseToml(text.replace(/\r\n/g, '\n'));
  if (!parsed.ok) fail('project-file-type-size-denied', { reason: parsed.message });
  const plugins = parsed.table.plugins;
  if (plugins === undefined) return [];
  if (!Array.isArray(plugins)) {
    // `[plugins]` settings tables are not install requests.
    return [];
  }
  if (plugins.length > 32) fail('project-plugin-limit', { count: plugins.length });
  return plugins.map((row, index) => asRequest(row, index));
}

export function reviewProjectFile(file: string): ProjectReview {
  if (basename(file) !== '.murmo.toml') fail('project-file-type-size-denied', { file });
  const st = lstatSync(file);
  if (!st.isFile() || st.size > PROJECT_MAX_BYTES) fail('project-file-type-size-denied', { file, size: st.size });
  const bytes = readFileSync(file);
  if (bytes.byteLength > PROJECT_MAX_BYTES) fail('project-file-type-size-denied', { size: bytes.byteLength });
  const digest = createHash('sha256').update(bytes).digest('hex');
  const project = realpathSync(dirname(resolve(file)));
  const requests = readProjectRequests(bytes.toString('utf8'));
  return {
    status: 'untrusted-project',
    project,
    digest,
    requests,
    warning: 'Project requests never grant publisher trust or permissions; review each package separately.',
  };
}

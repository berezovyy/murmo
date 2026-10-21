// Reads fixtures/ from disk for the portable loader, and writes fixture JSON
// back (regressions from shrinking) with invisible characters escaped.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EditorCase, EditorOpsFile, GeneratorFile, PureCase, PureFnFile, SuiteIndex } from '@murmo/fixtures';
import { type FixtureSource, indexFile, type Loaded, loadFixtures, variantsOf } from '../load.ts';
import type { SchemaSet } from '../schema.ts';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const fixturesDir = join(repoRoot, 'fixtures');

/** Top-level folders and files of fixtures/ that are code or config, not fixture data. */
const notData = new Set(['node_modules', 'test']);
const notDataFiles = new Set(['package.json', 'tsconfig.json']);

function jsonFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!(dir === base && notData.has(entry.name))) out.push(...jsonFiles(path, base));
    } else if (entry.name.endsWith('.json') && !(dir === base && notDataFiles.has(entry.name))) {
      out.push(path);
    }
  }
  return out;
}

const toKey = (base: string, path: string) => relative(base, path).split(sep).join('/');

export function readFixtureSource(dir = fixturesDir): FixtureSource {
  const json: Record<string, string> = {};
  const schemas: SchemaSet = {};
  for (const file of jsonFiles(dir)) {
    const key = toKey(dir, file);
    const text = readFileSync(file, 'utf8');
    if (key.startsWith('schema/')) schemas[key.slice('schema/'.length)] = JSON.parse(text);
    json[key] = text;
  }
  return {
    json,
    schemas,
    exists: (path) => existsSync(join(dir, path)),
    stat: (path) => {
      const file = join(dir, path);
      if (!existsSync(file) || !statSync(file).isFile()) return undefined;
      const bytes = readFileSync(file);
      return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    },
  };
}

export function loadFixtureDir(dir = fixturesDir): Loaded {
  return loadFixtures(readFixtureSource(dir));
}

/** Unicode escapes for anything an editor could drop or normalize unseen (see load.ts). */
export function stringifyFixture(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replace(/(?![ \n])[\p{Cc}\p{Cf}\p{M}\p{Z}\p{Co}]/gu, (ch) =>
    Array.from({ length: ch.length }, (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''),
  )}\n`;
}

/**
 * Saves a shrunk generator failure as a fixed case in the generator's
 * `failures` file and updates its declared size in suites.json, so the
 * failure runs on every later PR. Returns the file it wrote, relative to fixtures/.
 */
export function saveRegression(
  generator: GeneratorFile,
  generatorFile: string,
  c: EditorCase | PureCase,
  dir = fixturesDir,
): string {
  const target = generator.failures;
  const path = join(dir, target);
  const provenance = {
    source: `shrunk failure of ${generatorFile} (seed ${generator.seed})`,
    license: 'Apache-2.0 OR MIT',
    author: 'murmo',
  };
  let file: EditorOpsFile | PureFnFile;
  if (existsSync(path)) file = JSON.parse(readFileSync(path, 'utf8'));
  else if (generator.target.kind === 'pure-fn')
    file = { kind: 'pure-fn/v1', offsets: 'utf16', provenance, fn: generator.target.fn, cases: [] };
  else file = { kind: 'editor-ops/v1', offsets: 'utf16', provenance, cases: [] };
  const cases = (file.cases ?? []) as (EditorCase | PureCase)[];
  if (cases.some((x) => x.id === c.id)) throw new Error(`${target} already has case ${c.id}`);
  // Generated pure cases are parity-only; a saved one fails until someone reviews and states its output.
  const fixed =
    file.kind === 'pure-fn/v1' && !('output' in c)
      ? { ...c, output: null, note: 'Shrunk failure with no oracle output: replace null with the reviewed result.' }
      : c;
  cases.push(fixed);
  (file as { cases: unknown[] }).cases = cases;
  writeFileSync(path, stringifyFixture(file));

  const indexPath = join(dir, indexFile);
  const index: SuiteIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  const owner = index.suites.find((s) => s.file === generatorFile)?.owner ?? '02';
  const entry =
    index.suites.find((s) => s.file === target) ?? index.suites[index.suites.push({ file: target, owner }) - 1];
  if (!entry) throw new Error('suites.json entry vanished');
  entry.cases = cases.length;
  if (file.kind === 'editor-ops/v1')
    entry.variants = (cases as EditorCase[]).reduce((n, x) => n + variantsOf(x).length, 0);
  writeFileSync(indexPath, stringifyFixture(index));
  return target;
}

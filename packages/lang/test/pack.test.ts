import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  CASE_POLICY_FORMAT,
  encodeTable,
  type LanguagePackManifest,
  lookup,
  PACK_KIND,
  PackError,
  type PackProblem,
  PROVENANCE_FORMAT,
  TABLE_FORMAT,
} from '../src/index.ts';
import { installLanguagePack, openLanguagePack } from '../src/node/index.ts';

const root = mkdtempSync(join(tmpdir(), 'murmo-lang-pack-'));
after(() => rmSync(root, { recursive: true, force: true }));
let packs = 0;

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

interface Options {
  readonly lowercaseOnly?: readonly string[];
  readonly kind?: string;
}

/** A small pack in the shape lang-en builds: the session checks don't depend on the table's size. */
function writePack(options: Options = {}): { dir: string; record: string } {
  const dir = join(root, `pack-${++packs}`);
  mkdirSync(join(dir, 'licenses'), { recursive: true });
  const table = encodeTable([
    ['teh', 'the'],
    ['adn', 'and'],
    ['recieve', 'receive'],
  ]);
  const casePolicy = `${JSON.stringify({ format: CASE_POLICY_FORMAT, lowercaseOnly: options.lowercaseOnly ?? ['adn', 'teh'], reason: 'names' })}\n`;
  const files: Record<string, Uint8Array | string> = {
    'typos.bin': table,
    'case-policy.json': casePolicy,
    'provenance.csv': 'key,value,origin,category,file,line,level,review\n',
    NOTICE: 'notice\n',
    'licenses/SCOWL-Copyright': 'copyright\n',
  };
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(dir, file), bytes);
  const ref = (file: string) => ({
    file,
    sha256: sha(files[file] as Uint8Array),
    bytes: Buffer.byteLength(files[file] as string),
  });
  const manifest: LanguagePackManifest = {
    kind: (options.kind ?? PACK_KIND) as typeof PACK_KIND,
    language: 'en',
    policy: 'strict-common-v1',
    table: { ...ref('typos.bin'), format: TABLE_FORMAT, entries: 3 },
    casePolicy: { ...ref('case-policy.json'), format: CASE_POLICY_FORMAT },
    provenance: { ...ref('provenance.csv'), format: PROVENANCE_FORMAT, rows: 3 },
    notice: ref('NOTICE'),
    licenses: [{ ...ref('licenses/SCOWL-Copyright'), covers: 'SCOWL' }],
    sources: [
      { name: 'scowl', version: '2020.12.07', sha256: '0'.repeat(64), license: 'SCOWL', role: 'correction-source' },
    ],
    build: { tool: 'test', version: '1' },
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir, record: join(dir, 'state', 'validated.json') };
}

/** Rewrites a file in place and puts its mtime back, as a same-size corruption that stat can't see. */
function tamper(path: string, edit: (bytes: Buffer) => void): void {
  const { atime, mtime } = statSync(path);
  const bytes = readFileSync(path);
  edit(bytes);
  writeFileSync(path, bytes);
  utimesSync(path, atime, mtime);
}

function problem(dir: string, record: string, hash = true): PackProblem | 'ok' {
  const result = openLanguagePack(dir, record, { hash });
  return result.ok ? 'ok' : result.problem;
}

test('an installed pack opens with lookups and its case policy, and says how it was checked', () => {
  const { dir, record } = writePack();
  installLanguagePack(dir, record, () => new Date('2026-10-21T00:00:00Z'));
  const hashed = openLanguagePack(dir, record);
  assert.ok(hashed.ok);
  assert.equal(hashed.integrity, 'sha256');
  assert.equal(lookup(hashed.pack.table, 'recieve'), 'receive');
  assert.deepEqual([...hashed.pack.casePolicy.lowercaseOnly], ['adn', 'teh']);
  // Without a native hash (Claude's realm) the record is the check; doctor reports this.
  const trusted = openLanguagePack(dir, record, { hash: false });
  assert.ok(trusted.ok);
  assert.equal(trusted.integrity, 'install-record');
});

test('a same-size flipped table byte with its mtime restored disables correction where a native hash runs', () => {
  const { dir, record } = writePack();
  installLanguagePack(dir, record);
  tamper(join(dir, 'typos.bin'), (b) => {
    b[b.length - 1] = (b[b.length - 1] as number) ^ 0x01;
  });
  assert.equal(problem(dir, record), 'hash-mismatch');
  // Without hashing, size and mtime match: this is the documented limit of the record (plan 12, Risks).
  assert.equal(problem(dir, record, false), 'ok');
  // A rewrite that changes the mtime is caught everywhere.
  writeFileSync(join(dir, 'typos.bin'), readFileSync(join(dir, 'typos.bin')));
  utimesSync(join(dir, 'typos.bin'), new Date(), new Date(Date.now() + 5000));
  assert.equal(problem(dir, record, false), 'record-stale');
});

test('a wrong manifest hash disables correction even without native hashing', () => {
  const { dir, record } = writePack();
  installLanguagePack(dir, record);
  tamper(join(dir, 'manifest.json'), (b) => {
    const text = b.toString('utf8');
    const at = text.indexOf('"sha256": "') + '"sha256": "'.length;
    b[at] = b[at] === 0x30 ? 0x31 : 0x30;
  });
  assert.equal(problem(dir, record, false), 'record-stale');
  assert.equal(problem(dir, record, true), 'record-stale');
});

test('a pack without a current install record does not open', () => {
  const { dir, record } = writePack();
  assert.equal(problem(dir, record), 'not-validated');
  installLanguagePack(dir, record);
  const json = JSON.parse(readFileSync(record, 'utf8'));
  json.receipt.validator = 'murmo-lang-validator/0';
  writeFileSync(record, JSON.stringify(json));
  assert.equal(problem(dir, record), 'record-stale', 'a record from an older validator stops counting');
});

test('install refuses a damaged pack and removes the old record, so no session keeps trusting it', () => {
  const { dir, record } = writePack();
  installLanguagePack(dir, record);
  assert.ok(existsSync(record));
  tamper(join(dir, 'NOTICE'), (b) => {
    b[0] = (b[0] as number) ^ 0x20;
  });
  assert.throws(
    () => installLanguagePack(dir, record),
    (e: unknown) => e instanceof PackError && e.problem === 'hash-mismatch',
  );
  assert.equal(existsSync(record), false);
  assert.equal(problem(dir, record), 'not-validated');
});

test('unknown formats and mismatched files fail closed with their own reason', () => {
  const future = writePack({ kind: 'murmo-language-pack/v2' });
  assert.throws(
    () => installLanguagePack(future.dir, future.record),
    (e: unknown) => e instanceof PackError && e.problem === 'unknown-format',
  );
  assert.equal(problem(future.dir, future.record), 'unknown-format');
  // A case policy for a key the table lacks means the files don't belong together.
  const foreign = writePack({ lowercaseOnly: ['thier'] });
  assert.throws(
    () => installLanguagePack(foreign.dir, foreign.record),
    (e: unknown) => e instanceof PackError && e.problem === 'case-policy-invalid',
  );
  const missing = writePack();
  rmSync(join(missing.dir, 'typos.bin'));
  assert.equal(problem(missing.dir, missing.record), 'missing-file');
});

// Loading is the first anti-vacuity gate: a case that is malformed, unindexed,
// short of its declared count, or silently altered must fail before any
// subject runs it (E13, lesson 2).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type FixtureSource, loadFixtures } from '../src/load.ts';
import { readFixtureSource, repoRoot } from '../src/node/fixtures.ts';
import { validate } from '../src/schema.ts';

const fresh = (): FixtureSource => readFixtureSource();

interface EditableCase {
  steps: unknown[];
  plugins?: string[];
  project?: string;
  projectTrust?: string;
}
interface EditableFile {
  defaults?: { requires?: string[] };
  cases: EditableCase[];
}
const nth = (file: EditableFile, i: number): EditableCase => {
  const c = file.cases[i];
  assert.ok(c, `case ${i}`);
  return c;
};

/** A copy of the real fixtures with one JSON file changed. */
function edited(path: string, change: (data: EditableFile) => void): FixtureSource {
  const src = fresh();
  const data = JSON.parse(src.json[path] ?? 'null');
  change(data);
  return { ...src, json: { ...src.json, [path]: JSON.stringify(data, null, 2) } };
}

test('every fixture file validates against its schema and loads with no problems', () => {
  const loaded = loadFixtures(fresh());
  assert.deepEqual(loaded.problems, []);
  assert.ok(loaded.suites.length >= 16);
});

test('a planted invalid case fails loading, naming the file and field (E13)', () => {
  const src = edited('core/conformance/cases.json', (d) => {
    nth(d, 0).steps[0] = { keypress: 't' };
  });
  const { problems } = loadFixtures(src);
  assert.ok(
    problems.some((p) => p.startsWith('core/conformance/cases.json: $.cases[0].steps[0]')),
    problems.join('\n'),
  );
});

test('a suite that loads 26 of its 27 declared cases fails', () => {
  const src = edited('core/conformance/cases.json', (d) => {
    d.cases.pop();
  });
  const { problems } = loadFixtures(src);
  assert.ok(problems.includes('core/conformance/cases.json: declares 27 cases, loaded 26'), problems.join('\n'));
});

test('a fixture file missing from suites.json fails: it would never run', () => {
  const src = fresh();
  src.json['core/stray.json'] = src.json['stress/ime-normalization.json'] ?? '';
  const { problems } = loadFixtures(src);
  assert.ok(
    problems.includes('core/stray.json: not listed in suites.json, so it would never run'),
    problems.join('\n'),
  );
});

test('a raw invisible character fails; its \\u escape passes', () => {
  const path = 'stress/ime-normalization.json';
  const src = fresh();
  const text = src.json[path] ?? '';
  assert.ok(text.includes('\\u0301'), 'the file keeps NFD é escaped');
  src.json[path] = text.replace('\\u0301', '\u{301}');
  const { problems } = loadFixtures(src);
  assert.ok(
    problems.some((p) => p.startsWith(`${path}:`) && p.endsWith('raw U+0301; write it as a \\u escape')),
    problems.join('\n'),
  );
});

test('an unknown plugin name or project folder fails loading', () => {
  const src = edited('stress/huge-paste.json', (d) => {
    nth(d, 0).plugins = ['autocorect'];
    nth(d, 1).project = 'shortcuts/missing';
  });
  const { problems } = loadFixtures(src);
  assert.ok(
    problems.includes('stress/huge-paste.json paste-1mib-mid-draft: unknown plugin "autocorect"'),
    problems.join('\n'),
  );
  assert.ok(
    problems.some((p) => p.includes('project folder "shortcuts/missing" does not exist')),
    problems.join('\n'),
  );
});

test('a projectTrust case without host.project-config fails loading', () => {
  // Catches a project-config case reaching the pure subjects, which never read
  // `.murmo.toml` and so pass the unreviewed case for the wrong reason.
  const src = edited('hosts/project-shortcuts.json', (d) => {
    if (d.defaults) delete d.defaults.requires;
  });
  const { problems } = loadFixtures(src);
  assert.ok(
    problems.includes(
      'hosts/project-shortcuts.json unreviewed-project-shortcut-stays-literal: "projectTrust" needs "requires": ["host.project-config"]',
    ),
    problems.join('\n'),
  );
});

test('an installed-plugin case without host.installed-plugins fails loading', () => {
  // A subject that never runs `murmo plugin add` would pass the disabled case
  // (the send goes through) for the wrong reason.
  const src = edited('hosts/installed-plugin.json', (d) => {
    if (d.defaults) delete d.defaults.requires;
  });
  const { problems } = loadFixtures(src);
  assert.ok(
    problems.includes(
      'hosts/installed-plugin.json disabled-plugin-stops: "installed" needs "requires": ["host.installed-plugins"]',
    ),
    problems.join('\n'),
  );
});

test('a hostConfig case without host.config-files fails loading', () => {
  // A subject that never writes the user's own host settings would pass the
  // OpenCode theme case for the wrong reason.
  const src = edited('hosts/opencode-config.json', (d) => {
    if (d.defaults) d.defaults.requires = ['host=opencode'];
  });
  const { problems } = loadFixtures(src);
  assert.ok(
    problems.includes(
      'hosts/opencode-config.json opencode-user-theme-keeps-murmo: "hostConfig" needs "requires": ["host.config-files"]',
    ),
    problems.join('\n'),
  );
});

test('a moved file whose line endings changed fails its SHA-256 check (E17, E18)', () => {
  const src = fresh();
  const target = 'shortcuts/replacements/expected.json';
  const stat = src.stat;
  src.stat = (path) => {
    if (path !== target) return stat(path);
    const bytes = Buffer.from(readFileSync(join(repoRoot, 'fixtures', target), 'utf8').replace(/\n/g, '\r\n'));
    return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  };
  const { problems } = loadFixtures(src);
  assert.ok(
    problems.some((p) => p.startsWith(`shortcuts/moved.json: ${target} changed`)),
    problems.join('\n'),
  );
});

const experiments = join(repoRoot, 'experiments');
test('moved files still match their experiment sources byte for byte', {
  skip: existsSync(join(experiments, 'replacements')) ? false : 'experiments/ is not checked out here',
}, () => {
  for (const manifest of ['shortcuts/moved.json', 'names/moved.json']) {
    const moved = JSON.parse(readFileSync(join(repoRoot, 'fixtures', manifest), 'utf8'));
    for (const f of moved.files) {
      const source = readFileSync(join(repoRoot, f.source));
      assert.equal(createHash('sha256').update(source).digest('hex'), f.sha256, f.source);
    }
  }
});

test('the validator refuses a schema keyword it does not implement, instead of ignoring it', () => {
  assert.throws(
    () => validate({ 'x.json': { type: 'string', format: 'email' } }, 'x.json', 'a'),
    /unsupported keyword "format"/,
  );
});

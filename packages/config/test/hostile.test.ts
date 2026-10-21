// Hostile configs (phase 14 E5, lesson 60): the 16 r12 K3 cases give no raw
// control byte in any diagnostic or notice, oversized files are refused before
// parsing, deep nesting gives one bounded error, and the other file still loads.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStore } from '@murmo/store/node';
import {
  type ConfigFile,
  codePointLength,
  type Diagnostic,
  formatDiagnostic,
  makeDiagnostic,
  mergeConfig,
  parseConfig,
  resolveShortcuts,
} from '../src/index.ts';
import { loadSessionConfig } from '../src/node/index.ts';
import { configCases } from './fixtures.ts';
import { sourceOf, type TomlCase } from './parity-cases.ts';
import { workspace } from './repos.ts';

/** The part of a fixture's `config.parse` summary this file checks. */
interface Expected {
  readonly status: 'ok' | 'ignored';
  readonly diagnostics: readonly { readonly code: string }[];
  readonly shortcuts: readonly (readonly [string, unknown])[];
}

type HostileCase = TomlCase & { readonly output: Expected };

const cases = configCases('hostile.json') as HostileCase[];

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f\u{202a}-\u{202e}\u{2066}-\u{2069}]|[\ud800-\udfff]/u;

function assertDisplaySafe(name: string, diagnostics: readonly Diagnostic[]): void {
  for (const d of diagnostics) {
    for (const field of [d.file, d.message, d.excerpt ?? '']) {
      assert.doesNotMatch(field, RAW_CONTROL, `${name}: raw control in ${JSON.stringify(field)}`);
    }
  }
}

const project = (c: HostileCase): ConfigFile => parseConfig(sourceOf(c), { file: '.murmo.toml', origin: 'project' });

test('all 16 r12 cases have the expected outcome', () => {
  // Catches a hostile entry that loads (escape sequences, NUL, RTL) or a guard
  // that refuses a legitimate file.
  assert.equal(cases.length, 16);
  for (const c of cases) {
    const file = project(c);
    assert.equal(file.status, c.output.status, c.name);
    assert.deepEqual(
      file.diagnostics.map((d) => d.code),
      c.output.diagnostics.map((d) => d.code),
      c.name,
    );
    assert.deepEqual(
      file.shortcuts.map((s) => s.shortcut),
      c.output.shortcuts.map(([shortcut]) => shortcut),
      c.name,
    );
  }
});

test('no diagnostic or notice carries a raw control character', () => {
  // Catches a diagnostic that would let a .murmo.toml repaint the terminal (r12 K3).
  for (const c of cases) {
    const file = resolveShortcuts(project(c), new Map());
    assertDisplaySafe(c.name, file.diagnostics);
    const merged = mergeConfig({ project: file, projectTrusted: false });
    assertDisplaySafe(c.name, merged.diagnostics);
    for (const d of merged.diagnostics) assert.doesNotMatch(formatDiagnostic(d).replace('\n  ', ' '), RAW_CONTROL);
  }
  // A hostile path name is escaped too.
  const d = makeDiagnostic('error', 'parse', 'repo\u001b]52;c;x\u0007/.murmo.toml', { line: 1, column: 1 }, 'x');
  assert.equal(d.file, 'repo\\u001b]52;c;x\\u0007/.murmo.toml');
});

test('oversized files are refused before parsing', () => {
  // Catches a 100,000-shortcut file stalling session start in the parser.
  for (const name of ['huge', '100k']) {
    const c = cases.find((x) => x.name === name) as HostileCase;
    const started = performance.now();
    const file = project(c);
    const elapsed = performance.now() - started;
    // One error at 1:1 without an excerpt: the content was never looked at.
    assert.deepEqual(
      file.diagnostics.map((d) => [d.code, d.line, d.column, d.excerpt]),
      [['too-large', 1, 1, undefined]],
    );
    assert.ok(elapsed < 50, `${name} took ${elapsed} ms`);
  }
});

test('the loader refuses an oversized .murmo.toml without opening it', async () => {
  // Catches a reader that opens (and maybe reads) the whole file before the size check.
  const ws = workspace('murmo-hostile-');
  try {
    const huge = cases.find((x) => x.name === 'huge') as HostileCase;
    const root = ws.repo('huge', [{ op: 'write', path: '.murmo.toml', text: sourceOf(huge) }]);
    const opened: string[] = [];
    const realOpen = fsp.open;
    fsp.open = ((path: Parameters<typeof realOpen>[0], ...rest: unknown[]) => {
      opened.push(String(path));
      return (realOpen as (...args: unknown[]) => ReturnType<typeof realOpen>)(path, ...rest);
    }) as typeof realOpen;
    let session: Awaited<ReturnType<typeof loadSessionConfig>>;
    try {
      session = await loadSessionConfig({ cwd: root, store: await openStore({ roots: ws.roots }), env: ws.env });
    } finally {
      fsp.open = realOpen;
    }
    assert.ok(!opened.includes(join(await fsp.realpath(root), '.murmo.toml')), 'the file was opened');
    assert.equal(session.project?.config.diagnostics[0]?.code, 'too-large');
  } finally {
    ws.remove();
  }
});

test('deep nesting gives one bounded error, quickly', () => {
  // Catches a parser stack overflow or an excerpt that dumps 2,400 brackets.
  const c = cases.find((x) => x.name === 'deep') as HostileCase;
  const started = performance.now();
  const file = project(c);
  assert.ok(performance.now() - started < 50);
  assert.equal(file.diagnostics.length, 1);
  const [d] = file.diagnostics;
  assert.equal(d?.code, 'too-deep');
  assert.deepEqual([d?.line, d?.column], [1, 39]);
  assert.ok(codePointLength(d?.excerpt ?? '') <= 121);
});

test('a hostile project file never stops the user file from loading', () => {
  // Fail open per file: catches one bad file taking every shortcut down with it.
  const user = resolveShortcuts(
    parseConfig('[replace]\n";ok" = "fine"\n', { file: 'murmo.toml', origin: 'user' }),
    new Map(),
  );
  for (const c of cases) {
    for (const trusted of [false, true]) {
      const merged = mergeConfig({ user, project: resolveShortcuts(project(c), new Map()), projectTrusted: trusted });
      assert.ok(
        merged.replacements.some((s) => s.shortcut === ';ok' && s.text === 'fine'),
        `${c.name} (trusted ${trusted})`,
      );
    }
  }
});

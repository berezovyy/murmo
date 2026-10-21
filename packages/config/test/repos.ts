// Builds the throwaway repositories the trust tests and tools/config-parity.mjs
// load: a `.git` folder, a `.murmo.toml` and the files the cases in
// fixtures/config/trust.json describe. Everything lives under one temp folder
// the caller removes.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fixtureCases, fixturesDir } from './fixtures.ts';

export type RepoOp =
  | {
      readonly op: 'write';
      readonly path: string;
      readonly text?: string;
      readonly hex?: string;
      readonly repeat?: { readonly char: string; readonly count: number };
    }
  | { readonly op: 'append'; readonly path: string; readonly text: string }
  | { readonly op: 'unlink'; readonly path: string }
  | { readonly op: 'symlink'; readonly path: string; readonly target: string }
  | { readonly op: 'mkfifo'; readonly path: string };

export interface TrustCases {
  readonly base: readonly RepoOp[];
  readonly expected: Readonly<Record<string, string>>;
  readonly hostile: readonly {
    readonly name: string;
    readonly reference: string;
    readonly problem: string;
    readonly ops: readonly RepoOp[];
    /** Repository files the load may open while refusing the reference. */
    readonly opened: readonly string[];
  }[];
  readonly changes: readonly { readonly name: string; readonly ops: readonly RepoOp[] }[];
  readonly fixture: readonly RepoOp[];
  readonly fixtureExpected: Readonly<Record<string, string>>;
}

interface TrustInput {
  readonly ops?: readonly RepoOp[];
  readonly reference?: string;
  readonly otherRepo?: boolean;
  readonly copy?: { readonly from: string; readonly files: readonly string[] };
}

interface TrustOutput {
  readonly approved?: Readonly<Record<string, string>>;
  readonly trust?: string;
  readonly problem?: string;
  readonly opened?: readonly string[];
}

function loadTrustCases(): TrustCases {
  const cases = fixtureCases<TrustInput, TrustOutput>('trust.json');
  const one = (id: string) => cases.find((c) => c.id === id) ?? assertNever(id);
  const tagged = (tag: string) => cases.filter((c) => c.tags?.includes(tag));
  const base = one('base');
  const fixture = one('r8-fixture');
  const copy = fixture.input.copy ?? assertNever('r8-fixture copy');
  return {
    base: base.input.ops ?? [],
    expected: base.output.approved ?? {},
    hostile: tagged('hostile').map((c) => ({
      name: c.id.slice('hostile-'.length),
      reference: c.input.reference ?? '',
      problem: c.output.problem ?? '',
      ops: c.input.ops ?? [],
      opened: c.output.opened ?? [],
    })),
    changes: tagged('change').map((c) => ({ name: c.id.slice('change-'.length), ops: c.input.ops ?? [] })),
    fixture: copy.files.map((path) => ({
      op: 'write' as const,
      path,
      text: readFileSync(new URL(`${copy.from}/${path}`, fixturesDir), 'utf8'),
    })),
    fixtureExpected: fixture.output.approved ?? {},
  };
}

function assertNever(what: string): never {
  throw new Error(`fixtures/config/trust.json: no ${what}`);
}

export const trustCases: TrustCases = loadTrustCases();

/** A temp workspace: `home/` for the user file, `roots/` for the store, repositories beside them. */
export interface Workspace {
  readonly dir: string;
  readonly home: string;
  readonly outside: string;
  readonly roots: { readonly data: string; readonly state: string; readonly cache: string };
  readonly env: Readonly<Record<string, string>>;
  repo(name: string, ...ops: readonly (readonly RepoOp[])[]): string;
  apply(root: string, ops: readonly RepoOp[]): void;
  remove(): void;
}

export function workspace(prefix = 'murmo-config-'): Workspace {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'murmo'), { recursive: true });
  const outside = join(dir, 'outside.txt');
  writeFileSync(outside, 'outside\n');
  const roots = {
    data: join(dir, 'data', 'murmo'),
    state: join(dir, 'state', 'murmo'),
    cache: join(dir, 'cache', 'murmo'),
  };
  const ws: Workspace = {
    dir,
    home,
    outside,
    roots,
    env: { HOME: home },
    apply(root, ops) {
      for (const op of ops) {
        const path = join(root, op.path);
        mkdirSync(dirname(path), { recursive: true });
        switch (op.op) {
          case 'write':
            if (op.hex !== undefined) writeFileSync(path, Buffer.from(op.hex, 'hex'));
            else if (op.repeat) writeFileSync(path, op.repeat.char.repeat(op.repeat.count));
            else writeFileSync(path, op.text ?? '');
            break;
          case 'append':
            appendFileSync(path, op.text);
            break;
          case 'unlink':
            rmSync(path, { force: true });
            break;
          case 'symlink':
            symlinkSync(op.target === '{outside}' ? outside : op.target, path);
            break;
          case 'mkfifo':
            execFileSync('/usr/bin/mkfifo', [path]);
            break;
        }
      }
    },
    repo(name, ...ops) {
      const root = join(dir, name);
      mkdirSync(join(root, '.git'), { recursive: true });
      for (const list of ops) ws.apply(root, list);
      return root;
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return ws;
}

/** The base `.murmo.toml` with its one `file` reference pointed at `reference`. */
export function hostileConfig(reference: string): RepoOp {
  return {
    op: 'write',
    path: '.murmo.toml',
    text: `version=1\n[replace]\ntst={file=${JSON.stringify(reference)}}\n`,
  };
}

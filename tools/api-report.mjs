// The API report: `tsc` declarations for both entry points of @murmo/api
// (`@murmo/api`, `@murmo/api/adapter`), committed under packages/api/report/.
// While the API is a preview it is the only contract, so a silent type change is
// a silent breaking change (phase 03, E1). The gate:
//
//   1. the committed report must equal a fresh build (no stale report), and
//   2. if the report changed since the base revision, packages/api/docs/CHANGELOG.md
//      must have changed too.
//
//   node tools/api-report.mjs --write                   regenerate the report
//   node tools/api-report.mjs --check [--base <rev>]    the gate
//
// The CHANGELOG rule compares with the merge base of HEAD and --base (else
// MURMO_API_BASE, else origin/main); with no merge base it is skipped with a note.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { root } from './workspace.mjs';

export const apiDir = join(root, 'packages', 'api');
export const reportPath = 'packages/api/report';
export const changelogPath = 'packages/api/docs/CHANGELOG.md';

const tsc = join(root, 'node_modules', '.bin', 'tsc');

/** Emits the declarations of `dir`'s src/ into `outDir`; returns {file: text}. */
export function generate(outDir, dir = apiDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const run = spawnSync(tsc, ['-p', join(dir, 'tsconfig.report.json'), '--outDir', outDir], {
    cwd: root,
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`tsc failed while emitting the API report\n${run.stdout}${run.stderr}`);
  return readReport(outDir);
}

/** @returns {Record<string, string>} */
export function readReport(dir) {
  /** @type {Record<string, string>} */
  const files = {};
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir).sort()) files[name] = readFileSync(join(dir, name), 'utf8');
  return files;
}

/** File names whose contents differ between two reports (added, removed or changed). */
export function diffReports(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((name) => a[name] !== b[name]);
}

/**
 * The gate's verdict. `stale`: files where the committed report differs from a
 * fresh build. `changed`: paths that differ from the base revision, or null when
 * there is no base to compare with.
 */
export function verdict({ stale, changed }) {
  const problems = [];
  if (stale.length) {
    problems.push(`the committed API report is stale (${stale.join(', ')}): run \`pnpm api:report\` and commit it`);
  }
  if (changed) {
    const reportChanged = changed.some((path) => path.startsWith(`${reportPath}/`));
    if (reportChanged && !changed.includes(changelogPath)) {
      problems.push(`the API report changed but ${changelogPath} did not: describe the API change there`);
    }
  }
  return problems;
}

/** Paths under the report and the changelog that differ between `base` and the working tree. */
export function changedSince(base, cwd = root) {
  const run = spawnSync('git', ['diff', '--name-only', base, '--', reportPath, changelogPath], {
    cwd,
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`git diff against ${base} failed: ${run.stderr.trim()}`);
  return run.stdout.split('\n').filter(Boolean);
}

/** The merge base of HEAD and `rev`, so changes that landed on the base branch later don't count. */
function mergeBase(rev) {
  const run = spawnSync('git', ['merge-base', 'HEAD', rev], { cwd: root, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

function main(args) {
  const committed = join(apiDir, 'report');
  if (args.includes('--write')) {
    const files = generate(committed);
    console.log(`wrote ${Object.keys(files).length} files to ${relative(root, committed)}`);
    return 0;
  }
  if (!args.includes('--check')) {
    console.error('usage: node tools/api-report.mjs --write | --check [--base <rev>]');
    return 2;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'murmo-api-report-'));
  try {
    const stale = diffReports(readReport(committed), generate(scratch));
    const flag = args.indexOf('--base');
    const requested = (flag >= 0 ? args[flag + 1] : undefined) || process.env.MURMO_API_BASE || 'origin/main';
    const base = mergeBase(requested);
    if (!base) console.log(`api report: no merge base with ${requested}, CHANGELOG rule skipped`);
    const problems = verdict({ stale, changed: base ? changedSince(base) : null });
    for (const problem of problems) console.error(`FAIL ${problem}`);
    if (!problems.length) console.log(`api report: up to date${base ? ` (base ${base})` : ''}`);
    return problems.length ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));

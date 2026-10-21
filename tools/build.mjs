// Builds every bundle a workspace package declares under `murmo.bundles`,
// then runs the portability gate. One bundler (esbuild) for all runtimes.
//
//   node tools/build.mjs                         build + gate
//   node tools/build.mjs --verify-deterministic  also build twice and compare bytes
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { checkBundle, staticProblems } from './portable-check.mjs';
import { listPackages, root } from './workspace.mjs';

/** @typedef {{format: import('esbuild').Format, platform: import('esbuild').Platform, target: string, portable: boolean}} Target */

/** @satisfies {Record<string, Target>} */
export const targets = {
  node: { format: 'esm', platform: 'node', target: 'node24', portable: false },
  bun: { format: 'esm', platform: 'neutral', target: 'es2022', portable: true },
  claude: { format: 'esm', platform: 'neutral', target: 'es2022', portable: true },
  // es2022, not es2020: esbuild lowers private class members for es2020 to WeakMaps, and QuickJS
  // (2025-09-13) never frees the cycles those make with closures; a long core run leaks (phase 05).
  quickjs: { format: 'iife', platform: 'neutral', target: 'es2022', portable: true },
};

/** Every (package, bundle, target) the workspace declares. */
export function plannedBundles(packages = listPackages()) {
  const jobs = [];
  for (const pkg of packages) {
    for (const bundle of pkg.manifest.murmo?.bundles ?? []) {
      for (const target of bundle.targets) {
        targetOf(target);
        if (target === 'quickjs' && !bundle.global)
          throw new Error(`${pkg.manifest.name}: quickjs bundle needs "global"`);
        jobs.push({ pkg, bundle, target });
      }
    }
  }
  return jobs;
}

/** @returns {Target} */
export function targetOf(name) {
  const t = /** @type {Record<string, Target | undefined>} */ (targets)[name];
  if (!t) throw new Error(`unknown bundle target "${name}"`);
  return t;
}

async function buildOne({ pkg, bundle, target }, outRoot) {
  const t = targetOf(target);
  const outDir = outRoot ? join(outRoot, relative(root, pkg.dir)) : pkg.dir;
  const outfile = join(outDir, 'dist', target, `${bundle.name}.js`);
  const metaFile = join(outDir, 'dist', 'meta', target, `${bundle.name}.json`);
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(pkg.dir, bundle.entry)],
    outfile,
    bundle: true,
    format: t.format,
    platform: t.platform,
    target: t.target,
    ...(t.format === 'iife' ? { globalName: bundle.global } : {}),
    ...(t.platform === 'neutral' ? { mainFields: ['module', 'main'], conditions: ['import', 'default'] } : {}),
    legalComments: 'eof',
    sourcemap: false,
    charset: 'utf8',
    metafile: true,
    logLevel: 'warning',
  });
  mkdirSync(join(metaFile, '..'), { recursive: true });
  writeFileSync(metaFile, `${JSON.stringify(result.metafile, null, 2)}\n`);
  return { outfile, metaFile };
}

/** @param {{outRoot?: string | undefined, packages?: {dir: string, manifest: any}[]}} [options] */
export async function buildAll({ outRoot, packages = listPackages() } = {}) {
  const jobs = plannedBundles(packages);
  const built = [];
  for (const job of jobs) built.push({ ...job, ...(await buildOne(job, outRoot)) });
  return built;
}

export async function gate(built, packages) {
  const failures = [];
  for (const b of built) {
    const t = targetOf(b.target);
    const portable = t.portable && b.pkg.manifest.murmo?.runtime === 'portable';
    const problems = t.portable
      ? await checkBundle({ file: b.outfile, metafileFile: b.metaFile, format: t.format, packages, portable })
      : staticProblems({
          code: '',
          metafile: JSON.parse(readFileSync(b.metaFile, 'utf8')),
          packages,
          portable: false,
        });
    for (const p of problems) failures.push(`${b.pkg.manifest.name} [${b.target}] ${b.bundle.name}: ${p}`);
  }
  return failures;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function verifyDeterministic(packages) {
  const dirs = [mkdtempSync(join(tmpdir(), 'murmo-build-a-')), mkdtempSync(join(tmpdir(), 'murmo-build-b-'))];
  try {
    const [a, b] = [await buildAll({ outRoot: dirs[0], packages }), await buildAll({ outRoot: dirs[1], packages })];
    return a
      .map((x, i) => [x, b[i]])
      .filter(([x, y]) => sha256(x.outfile) !== sha256(y.outfile))
      .map(([x]) => `${x.pkg.manifest.name} [${x.target}] ${x.bundle.name}: two builds differ`);
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
}

async function main() {
  const packages = listPackages();
  const built = await buildAll({ packages });
  const failures = await gate(built, packages);
  if (process.argv.includes('--verify-deterministic')) failures.push(...(await verifyDeterministic(packages)));
  for (const b of built) {
    const bytes = readFileSync(b.outfile);
    console.log(
      `${relative(root, b.outfile).padEnd(48)} ${String(bytes.length).padStart(9)} B  ${String(gzipSync(bytes).length).padStart(8)} B gzip`,
    );
  }
  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

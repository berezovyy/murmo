// The four runtime launchers for the pure subject (docs/plan/02 § Runner).
// Node imports the runner; Bun runs guest-cli.ts as a child process; the two
// QuickJS embeddings load the `quickjs` IIFE bundle and get the suites as
// JSON, since guests have no file system. All four call the same runPure.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { englishPackBanner, loadEnglishPack } from '@murmo/plugin-autocorrect/node';
import { build } from 'esbuild';
import { getQuickJS } from 'quickjs-emscripten';
import { coreSuites, type GuestRequest, runCore, runPure } from '../guest.ts';
import type { LoadedSuite, RunOptions, RunResult } from '../types.ts';
import { repoRoot } from './fixtures.ts';

export const runtimes = ['node', 'bun', 'quickjs-wasm', 'rquickjs'] as const;
export type RuntimeName = (typeof runtimes)[number];

const packageDir = join(repoRoot, 'packages', 'conformance');
export const guestGlobal = 'MurmoConformance';

/** Interrupt budget for one guest call: burst 10,000 takes about 5 s in QuickJS. */
export const guestBudgetMs = 120_000;

/** The suites a pure subject can run: pure-fn files and generators with a pure-fn target. */
export function pureSuites(suites: LoadedSuite[]): LoadedSuite[] {
  return suites.filter(
    (s) => s.kind === 'pure-fn' || (s.kind === 'generator' && s.generator.target.kind === 'pure-fn'),
  );
}

/** Builds src/guest.ts as the quickjs IIFE bundle (the same settings as `murmo.bundles`). */
export async function buildGuest(outfile: string): Promise<string> {
  const pack = loadEnglishPack();
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [join(packageDir, 'src', 'guest.ts')],
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    // tools/build.mjs `targets.quickjs`: es2020 lowering of private members leaks in QuickJS.
    target: 'es2022',
    globalName: guestGlobal,
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    charset: 'utf8',
    logLevel: 'warning',
    banner: { js: englishPackBanner(pack) },
  });
  return outfile;
}

function parseResult(runtime: string, text: string): RunResult {
  try {
    return JSON.parse(text) as RunResult;
  } catch {
    throw new Error(`${runtime}: output is not a run result: ${text.slice(0, 400)}`);
  }
}

function runQuickjsWasm(bundle: string, request: string): Promise<RunResult> {
  return getQuickJS().then((quickjs) => {
    const vm = quickjs.newContext();
    try {
      const deadline = Date.now() + guestBudgetMs;
      vm.runtime.setInterruptHandler(() => Date.now() > deadline);
      vm.unwrapResult(vm.evalCode(readFileSync(bundle, 'utf8'))).dispose();
      vm.setProp(vm.global, '__request', vm.newString(request));
      const handle = vm.unwrapResult(
        vm.evalCode(`JSON.stringify(${guestGlobal}.runPure(JSON.parse(globalThis.__request)))`),
      );
      const text = vm.getString(handle);
      handle.dispose();
      return parseResult('quickjs-wasm', text);
    } finally {
      vm.dispose();
    }
  });
}

/**
 * The core subject in QuickJS-wasm: `runCore` returns a promise, so the
 * embedder runs the job loop until it settles. The core's clock is manual and
 * QuickJS has no timers, so an empty job queue before a result means a hang.
 */
function runCoreQuickjsWasm(bundle: string, request: string): Promise<RunResult> {
  return getQuickJS().then((quickjs) => {
    const runtime = quickjs.newRuntime();
    runtime.setMemoryLimit(1 << 30);
    const vm = runtime.newContext();
    try {
      const deadline = Date.now() + coreBudgetMs;
      runtime.setInterruptHandler(() => Date.now() > deadline);
      vm.unwrapResult(vm.evalCode(readFileSync(bundle, 'utf8'))).dispose();
      vm.setProp(vm.global, '__request', vm.newString(request));
      vm.unwrapResult(
        vm.evalCode(
          `${guestGlobal}.runCore(JSON.parse(globalThis.__request)).then(` +
            '(r) => { globalThis.__out = JSON.stringify(r); }, ' +
            '(e) => { globalThis.__err = String((e && e.stack) || e); });',
        ),
      ).dispose();
      for (;;) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          const error = vm.dump(jobs.error);
          jobs.error.dispose();
          throw new Error(`quickjs-wasm: core job failed: ${JSON.stringify(error)}`);
        }
        const read = (name: string): string | undefined => {
          const handle = vm.getProp(vm.global, name);
          const value = vm.typeof(handle) === 'string' ? vm.getString(handle) : undefined;
          handle.dispose();
          return value;
        };
        const err = read('__err');
        if (err !== undefined) throw new Error(`quickjs-wasm: core run failed: ${err}`);
        const out = read('__out');
        if (out !== undefined) return parseResult('quickjs-wasm', out);
        if (jobs.value === 0)
          throw new Error('quickjs-wasm: the core run stopped with no result (a promise never settled)');
      }
    } finally {
      // The English table (~2 MiB) plus a full core run can leave QuickJS GC
      // objects; JS_FreeRuntime then aborts. The process is one-shot.
      try {
        vm.dispose();
      } catch {
        /* already torn down */
      }
      try {
        runtime.dispose();
      } catch {
        /* JS_FreeRuntime assertion after a long core run */
      }
    }
  });
}

function spawnJson(runtime: string, command: string, args: string[]): RunResult {
  const run = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 << 20 });
  if (run.error) throw new Error(`${runtime}: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`${runtime} exited ${run.status}: ${run.stderr.slice(-2000)}`);
  return parseResult(runtime, run.stdout);
}

/** The Bun binary: MURMO_BUN, else `bun` on PATH. */
export function bunCommand(): string {
  return process.env.MURMO_BUN ?? 'bun';
}

export function bunAvailable(): boolean {
  const run = spawnSync(bunCommand(), ['--version'], { encoding: 'utf8' });
  return run.status === 0;
}

export interface LaunchOptions {
  mode: RunOptions['mode'];
  /** A prebuilt guest bundle; built into a temporary folder when absent. */
  bundle?: string;
}

/** The runtimes the core subject runs on; rquickjs runs it with the plugin host (phase 10). */
export const coreRuntimes = ['node', 'bun', 'quickjs-wasm'] as const;
export type CoreRuntimeName = (typeof coreRuntimes)[number];

/** Interrupt budget for one QuickJS-wasm core run over every editor-ops suite. */
export const coreBudgetMs = 900_000;

/** Runs every editor-ops suite through the core subject on one runtime. */
export async function launchCore(
  runtime: CoreRuntimeName,
  suites: LoadedSuite[],
  options: LaunchOptions,
): Promise<RunResult> {
  const request: GuestRequest = { runtime, mode: options.mode, suites: coreSuites(suites) };
  loadEnglishPack();
  if (runtime === 'node') return runCore(request, () => performance.now());
  const dir = mkdtempSync(join(tmpdir(), 'murmo-conformance-'));
  try {
    const requestFile = join(dir, 'request.json');
    writeFileSync(requestFile, JSON.stringify(request));
    if (runtime === 'bun') {
      return spawnJson('bun', bunCommand(), [join(packageDir, 'src', 'node', 'guest-cli.ts'), '--core', requestFile]);
    }
    const bundle = options.bundle ?? (await buildGuest(join(dir, 'conformance-guest.js')));
    return await runCoreQuickjsWasm(bundle, JSON.stringify(request));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs every pure suite on one runtime and returns its verdicts. */
export async function launch(runtime: RuntimeName, suites: LoadedSuite[], options: LaunchOptions): Promise<RunResult> {
  const request: GuestRequest = { runtime, mode: options.mode, suites: pureSuites(suites) };
  loadEnglishPack();
  if (runtime === 'node') return runPure(request);
  const dir = mkdtempSync(join(tmpdir(), 'murmo-conformance-'));
  try {
    const requestFile = join(dir, 'request.json');
    writeFileSync(requestFile, JSON.stringify(request));
    if (runtime === 'bun')
      return spawnJson('bun', bunCommand(), [join(packageDir, 'src', 'node', 'guest-cli.ts'), requestFile]);
    const bundle = options.bundle ?? (await buildGuest(join(dir, 'conformance-guest.js')));
    if (runtime === 'quickjs-wasm') return await runQuickjsWasm(bundle, JSON.stringify(request));
    return spawnJson('rquickjs', process.execPath, [
      join(repoRoot, 'tools', 'cargo.mjs'),
      'run',
      '--quiet',
      '--offline',
      '--locked',
      '-p',
      'murmo-js-runtime',
      '--example',
      'eval',
      '--',
      bundle,
      `${guestGlobal}.runPure`,
      `@${requestFile}`,
      String(guestBudgetMs),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

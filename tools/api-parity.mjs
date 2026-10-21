// Manifest verdict parity: the manifest preflight must admit and refuse the same
// manifests on Node, Bun, QuickJS-wasm and rquickjs, or a plugin that passes
// `murmo plugin test` is treated differently by the helper (lesson 73; phase 03
// "Same verdicts everywhere"). The cases are packages/api/test/manifest-cases.json;
// phase 02's conformance runner takes them over as fixtures/api/manifest/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';
import { getQuickJS } from 'quickjs-emscripten';
import { targets } from './build.mjs';
import { root } from './workspace.mjs';

const casesFile = join(root, 'packages/api/test/manifest-cases.json');
const entry = join(root, 'packages/api/test/manifest-cases.ts');
const global = 'ManifestCases';

/** @returns {Promise<{runtimes: string[], skipped: string[], cases: number}>} */
export async function manifestParity() {
  const json = readFileSync(casesFile, 'utf8');
  const file = JSON.parse(json);
  const call = `JSON.stringify(${global}.run(${JSON.stringify(file)}))`;
  const dir = mkdtempSync(join(tmpdir(), 'murmo-api-parity-'));
  try {
    const bundle = join(dir, 'manifest-cases.js');
    const t = targets.quickjs;
    await build({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      format: t.format,
      platform: t.platform,
      target: t.target,
      globalName: global,
      logLevel: 'warning',
    });
    const code = readFileSync(bundle, 'utf8');

    /** @type {Record<string, unknown>} */
    const results = {};
    const context = createContext({});
    runInContext(code, context);
    results.node = JSON.parse(runInContext(call, context));

    const vm = (await getQuickJS()).newContext();
    try {
      vm.unwrapResult(vm.evalCode(code)).dispose();
      const handle = vm.unwrapResult(vm.evalCode(call));
      results['quickjs-wasm'] = JSON.parse(vm.getString(handle));
      handle.dispose();
    } finally {
      vm.dispose();
    }

    const cargo = ['tools/cargo.mjs', 'run', '--quiet', '--offline', '--locked', '-p', 'murmo-js-runtime'];
    const rust = spawnSync(
      process.execPath,
      [...cargo, '--example', 'eval', '--', bundle, `${global}.run`, JSON.stringify(file)],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(rust.status, 0, rust.stderr);
    results.rquickjs = JSON.parse(rust.stdout);

    const skipped = [];
    const bunScript = join(dir, 'bun.js');
    writeFileSync(bunScript, `${code}\nconsole.log(${call});\n`);
    const bun = spawnSync('bun', [bunScript], { cwd: dir, encoding: 'utf8' });
    if (bun.error) skipped.push(`bun (${bun.error.message})`);
    else {
      assert.equal(bun.status, 0, bun.stderr);
      results.bun = JSON.parse(bun.stdout);
    }

    const expected = file.cases.map((/** @type {any} */ c) => ({ id: c.id, ...c.output }));
    assert.deepEqual(results.node, expected, 'Node verdicts differ from manifest-cases.json');
    for (const [runtime, verdicts] of Object.entries(results)) {
      assert.deepEqual(verdicts, results.node, `${runtime} manifest verdicts differ from Node`);
    }
    return { runtimes: Object.keys(results), skipped, cases: expected.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

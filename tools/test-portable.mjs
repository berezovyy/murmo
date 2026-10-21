// Portable-runtime checks that need built bundles or the Rust toolchain:
// QuickJS parity of a smoke bundle, the language pack's session cost (phase
// 12), then the conformance gate (phase 02).
//
// QuickJS parity: the same guest bundle must give the same result in Node, in
// QuickJS-wasm (used by executor tests) and in the rquickjs build the Codex
// wrapper and plugin host embed, or the one JS policy drifts (lesson 57).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';
import { getQuickJS } from 'quickjs-emscripten';
import { manifestParity } from './api-parity.mjs';
import { targets } from './build.mjs';
import { LIMITS, langLoadCost } from './lang-load.mjs';
import { runConformance } from './test-conformance.mjs';
import { root } from './workspace.mjs';

async function quickjsParity() {
  const dir = mkdtempSync(join(tmpdir(), 'murmo-parity-'));
  try {
    const outfile = join(dir, 'guest-smoke.js');
    const t = targets.quickjs;
    await build({
      entryPoints: [join(root, 'tools/test/fixtures/guest-smoke.ts')],
      outfile,
      bundle: true,
      format: t.format,
      platform: t.platform,
      target: t.target,
      globalName: 'GuestSmoke',
      logLevel: 'warning',
    });
    const code = readFileSync(outfile, 'utf8');

    const context = createContext({});
    runInContext(code, context);
    const node = runInContext('JSON.stringify(GuestSmoke.run())', context);

    const vm = (await getQuickJS()).newContext();
    let wasm;
    try {
      vm.unwrapResult(vm.evalCode(code)).dispose();
      const handle = vm.unwrapResult(vm.evalCode('JSON.stringify(GuestSmoke.run())'));
      wasm = vm.getString(handle);
      handle.dispose();
    } finally {
      vm.dispose();
    }

    const rust = spawnSync(
      'node',
      [
        join(root, 'tools/cargo.mjs'),
        'run',
        '--quiet',
        '--offline',
        '--locked',
        '-p',
        'murmo-js-runtime',
        '--example',
        'eval',
        '--',
        outfile,
        'GuestSmoke.run',
        'null',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(rust.status, 0, rust.stderr);

    assert.deepEqual(JSON.parse(wasm), JSON.parse(node), 'QuickJS-wasm differs from Node');
    assert.deepEqual(JSON.parse(rust.stdout), JSON.parse(node), 'rquickjs differs from Node');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await quickjsParity();
console.log('quickjs parity: Node, QuickJS-wasm and rquickjs agree');

const manifest = await manifestParity();
console.log(`manifest parity: ${manifest.cases} cases agree on ${manifest.runtimes.join(', ')}`);
for (const skip of manifest.skipped) console.log(`manifest parity: SKIP ${skip}`);
for (const r of await langLoadCost()) {
  console.log(
    `language pack on ${r.runtime}: open ${r.openColdMs.toFixed(2)} ms (≤ ${LIMITS.openMs}), lookup p50/p99 ${r.lookupP50Us.toFixed(1)}/${r.lookupP99Us.toFixed(1)} µs (≤ ${LIMITS.lookupP99Ms} ms)`,
  );
}
await runConformance();

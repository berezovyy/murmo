// Portable-runtime checks that need built bundles or the Rust toolchain.
// Phase 02 adds the conformance runners here.
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
import { targets } from './build.mjs';
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

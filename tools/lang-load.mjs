// Language-pack session cost on every runtime that loads it (docs/plan/12,
// "Load cost" and "Lookup"): opening the real English pack from its install
// record, without per-entry validation or hashing, must take ≤ 6 ms, and a
// lookup's p99 must stay ≤ 1 ms, in Node, Bun, QuickJS-wasm and rquickjs.
// Catches validation creeping back onto startup (lesson 66: 1.7 s in QuickJS)
// and a format change that breaks the key-path budget.
//
// The Codex wrapper's actual-entry activation (round 13: 2,087.7 ms) is
// measured by phase 23 against its real entry; this measures the pack's part.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';
import { getQuickJS } from 'quickjs-emscripten';
import { bunCommand } from '../packages/conformance/src/node/index.ts';
import { keyAt, mapTable } from '../packages/lang/src/index.ts';
import { installLanguagePack } from '../packages/lang/src/node/index.ts';
import { ensurePack } from '../packages/lang-en/src/index.ts';
import { targets } from './build.mjs';
import { root } from './workspace.mjs';

export const LIMITS = { openMs: 6, lookupP99Ms: 1 };
const global = 'LangCost';

/** Every 40th key, each with a one-letter change that usually misses: 4,426 lookups. */
function words(tableBytes) {
  const table = mapTable(tableBytes);
  const out = [];
  for (let i = 0; i < table.entries; i += 40) {
    const key = keyAt(table, i);
    out.push(key, `${key.slice(0, -1)}q`);
  }
  return out;
}

/** @returns {Promise<{runtime: string, entries: number, integrity: string, openColdMs: number, openMedianMs: number, lookupP50Us: number, lookupP99Us: number, lookupMaxUs: number, hits: number}[]>} */
export async function langLoadCost() {
  const dir = mkdtempSync(join(tmpdir(), 'murmo-lang-load-'));
  try {
    const pack = join(dir, 'pack');
    cpSync(ensurePack(), pack, { recursive: true });
    const recordFile = join(dir, 'validated.json');
    installLanguagePack(pack, recordFile);
    const file = (name) => readFileSync(join(pack, name));
    const mtime = (name) => Math.trunc(statSync(join(pack, name)).mtimeMs);
    const table = file('typos.bin');
    const input = {
      manifest: file('manifest.json').toString('base64'),
      table: table.toString('base64'),
      casePolicy: file('case-policy.json').toString('base64'),
      record: readFileSync(recordFile).toString('base64'),
      mtimeMs: { manifest: mtime('manifest.json'), table: mtime('typos.bin'), casePolicy: mtime('case-policy.json') },
      words: words(new Uint8Array(table.buffer, table.byteOffset, table.byteLength).slice()),
      opens: 15,
    };
    const inputFile = join(dir, 'input.json');
    writeFileSync(inputFile, JSON.stringify(input));

    const bundle = join(dir, 'session-cost.js');
    const t = targets.quickjs;
    await build({
      entryPoints: [join(root, 'packages/lang/test/session-cost.ts')],
      outfile: bundle,
      bundle: true,
      format: t.format,
      platform: t.platform,
      target: t.target,
      globalName: global,
      logLevel: 'warning',
    });
    const code = readFileSync(bundle, 'utf8');
    const call = `JSON.stringify(${global}.run(JSON.parse(globalThis.__input)))`;
    const json = JSON.stringify(input);
    const results = [];

    const context = createContext({ performance, __input: json });
    runInContext(code, context);
    results.push({ runtime: 'node', ...JSON.parse(runInContext(call, context)) });

    const bunScript = join(dir, 'bun.js');
    writeFileSync(
      bunScript,
      `${code}\nglobalThis.__input = require('node:fs').readFileSync(${JSON.stringify(inputFile)}, 'utf8');\nconsole.log(${call});\n`,
    );
    const bun = spawnSync(bunCommand(), [bunScript], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
    assert.equal(bun.error, undefined, `bun: ${bun.error?.message} (set MURMO_BUN)`);
    assert.equal(bun.status, 0, bun.stderr);
    results.push({ runtime: 'bun', ...JSON.parse(bun.stdout) });

    // QuickJS-wasm has no performance.now: the host lends its clock, as an adapter would.
    const vm = (await getQuickJS()).newContext();
    try {
      const perf = vm.newObject();
      const now = vm.newFunction('now', () => vm.newNumber(performance.now()));
      vm.setProp(perf, 'now', now);
      vm.setProp(vm.global, 'performance', perf);
      now.dispose();
      perf.dispose();
      vm.setProp(vm.global, '__input', vm.newString(json));
      vm.unwrapResult(vm.evalCode(code)).dispose();
      const handle = vm.unwrapResult(vm.evalCode(call));
      results.push({ runtime: 'quickjs-wasm', ...JSON.parse(vm.getString(handle)) });
      handle.dispose();
    } finally {
      vm.dispose();
    }

    const cargo = ['tools/cargo.mjs', 'run', '--quiet', '--offline', '--locked', '-p', 'murmo-js-runtime'];
    const rust = spawnSync(
      process.execPath,
      [...cargo, '--example', 'eval', '--', bundle, `${global}.run`, `@${inputFile}`, '60000'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 },
    );
    assert.equal(rust.status, 0, rust.stderr);
    results.push({ runtime: 'rquickjs', ...JSON.parse(rust.stdout) });

    for (const r of results) {
      assert.equal(r.integrity, 'install-record', `${r.runtime}: opened without hashing`);
      assert.ok(r.hits >= input.words.length / 2, `${r.runtime}: every sampled key is found`);
      assert.equal(r.hits, results[0].hits, `${r.runtime}: same lookups as Node`);
      assert.ok(
        r.openColdMs <= LIMITS.openMs,
        `${r.runtime}: session start took ${r.openColdMs.toFixed(3)} ms (limit ${LIMITS.openMs})`,
      );
      assert.ok(
        r.lookupP99Us <= LIMITS.lookupP99Ms * 1000,
        `${r.runtime}: lookup p99 ${r.lookupP99Us.toFixed(1)} µs (limit ${LIMITS.lookupP99Ms} ms)`,
      );
    }
    return results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const r of await langLoadCost()) console.log(JSON.stringify(r));
}

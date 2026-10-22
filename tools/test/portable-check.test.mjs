// The portability gate must reject what breaks in Claude's runtime or QuickJS
// before a bundle reaches a host (docs/plan/01 E3, E7). The real workspace
// bundles passing the gate is checked by `pnpm build` itself.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { dynamicProblems, staticProblems } from '../portable-check.mjs';
import { root } from '../workspace.mjs';

const pkg = {
  dir: join(root, 'packages', 'demo'),
  manifest: { name: '@murmo/demo', dependencies: { 'smol-toml': '1' } },
};
const metafile = (imports) => ({ inputs: { 'packages/demo/src/index.ts': { imports } } });
const clean = metafile([]);

const statics = (code, meta = clean) => staticProblems({ code, metafile: meta, packages: [pkg], portable: true });

test('process access is rejected: Claude and QuickJS have no process', async () => {
  const code = 'var M=(()=>{const level=process.env.LEVEL;return{level}})();';
  assert.match(statics(code).join('\n'), /process/);
  assert.match((await dynamicProblems({ code: 'var M=process.env.X;', format: 'iife' })).join('\n'), /process/);
});

test('process as a property passes: Claude hands plugins `$.process.spawn` (docs/plan/24)', () => {
  // Catches the gate refusing the packed Claude entry, whose analyzer only
  // accepts `$.noun.event(...)`, while `globalThis.process` still fails.
  assert.deepEqual(statics('var M=(t)=>t.process.spawn({argv:["x"]});'), []);
  assert.match(statics('var M=globalThis.process.env.X;').join('\n'), /process/);
  assert.match(statics('var M=globalThis?.process.env.X;').join('\n'), /process/);
  assert.match(statics('var M=1;process.exit(1)').join('\n'), /process/);
});

test('eval and new Function are rejected: the Claude runtime throws on both', async () => {
  assert.match(statics('var M=eval("1");').join('\n'), /eval/);
  assert.match(statics('var M=new Function("return 1");').join('\n'), /new Function/);
  assert.match(
    (await dynamicProblems({ code: 'var M=(0,globalThis["ev"+"al"])("1");', format: 'iife' })).join('\n'),
    /restricted realm/,
  );
});

test('a runtime built-in module import is rejected: a single-file bundle cannot load node:fs', () => {
  const problems = statics(
    'import{readFileSync}from"node:fs";',
    metafile([{ path: 'node:fs', original: 'node:fs', external: true }]),
  );
  assert.ok(problems.some((p) => p.includes('external import `node:fs`')));
  assert.ok(problems.some((p) => p.includes('runtime built-in')));
});

test('a global the pattern list does not name fails at load: Intl.Segmenter is missing in QuickJS (r12 E1)', async () => {
  const code = 'var M=(()=>{const s=new Intl.Segmenter("en");return s})();';
  assert.deepEqual(statics(code), []);
  assert.match((await dynamicProblems({ code, format: 'iife' })).join('\n'), /Segmenter/);
});

test('an undeclared import is rejected: it resolves in the workspace but breaks once packed', () => {
  const problems = staticProblems({
    code: '',
    metafile: metafile([{ path: 'x', original: 'esbuild' }]),
    packages: [pkg],
    portable: false,
  });
  assert.match(problems.join('\n'), /does not declare/);
});

test('a declared but non-allowlisted package is rejected in portable code', () => {
  const withLeftPad = { ...pkg, manifest: { ...pkg.manifest, dependencies: { 'left-pad': '1' } } };
  const problems = staticProblems({
    code: '',
    metafile: metafile([{ path: 'x', original: 'left-pad' }]),
    packages: [withLeftPad],
    portable: true,
  });
  assert.match(problems.join('\n'), /portable allowlist/);
});

test('esbuild runtime helpers are not an external import: lowered class fields are inlined (phases 02, 03)', () => {
  assert.deepEqual(
    statics('var M=1;', metafile([{ path: '<runtime>', kind: 'import-statement', external: true }])),
    [],
  );
});

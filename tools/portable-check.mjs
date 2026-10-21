// Portability gate for bundles that run outside Node: Claude's plugin runtime,
// OpenCode's bundled Bun, and rquickjs (Codex wrapper, plugin host).
// Claude has no Node, require or WebAssembly and throws on eval/new Function;
// QuickJS has no Intl.Segmenter, TextEncoder or timers (docs/plan/01, E3, E7).
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';
import { getQuickJS } from 'quickjs-emscripten';
import { declaredDependencies, packageNameOf, root } from './workspace.mjs';

/** Third-party packages portable code may bundle. Each entry needs a reason. */
export const portableAllowlist = new Map([
  ['smol-toml', 'TOML on every JS host, Bun included (lesson 27)'],
  ['unicode-segmenter', 'grapheme fallback where Intl.Segmenter is missing, as in QuickJS (r12 E1)'],
]);

/** @type {[RegExp, string][]} */
const forbiddenSource = [
  [/\beval\s*\(/, 'eval( throws in the Claude runtime'],
  [/\bnew\s+Function\s*\(/, 'new Function throws in the Claude runtime'],
  [/\bWebAssembly\b/, 'WebAssembly is missing in Claude and QuickJS'],
  [/\brequire\s*\(/, 'require is missing in Claude and QuickJS'],
  [/\bimport\s*\(/, 'dynamic import is not supported by the embedded loaders'],
  [/\bprocess\s*[.[]/, 'process exists only on Node and Bun'],
  [/\bBuffer\s*[.[(]/, 'Buffer exists only on Node and Bun'],
  [/\bBun\s*[.[]/, 'Bun APIs exist only on Bun'],
  [/\bfrom\s*["'](?:node|bun):/, 'runtime built-in modules exist only on Node and Bun'],
];

/** Static checks over the esbuild metafile and the bundle text. */
export function staticProblems({ code, metafile, packages, portable, allowedExternal = [] }) {
  const problems = [];
  const allowed = new Set(allowedExternal);
  for (const [pattern, why] of forbiddenSource) {
    const match = pattern.exec(stripLegalComments(code));
    if (match) problems.push(`forbidden \`${match[0]}\`: ${why}`);
  }
  for (const [input, info] of Object.entries(metafile.inputs)) {
    const owner = ownerOf(input, packages);
    for (const imp of info.imports ?? []) {
      // esbuild's own helpers (class fields, spread, ...) are inlined into the
      // bundle but listed as an external `<runtime>` import.
      if (imp.path === '<runtime>') continue;
      const spec = imp.original ?? imp.path;
      const name = isBare(spec) ? packageNameOf(spec) : spec;
      const hostProvided =
        allowed.has(spec) || allowed.has(name) || (!portable && (spec.startsWith('node:') || spec.startsWith('bun:')));
      if (imp.external && !hostProvided) {
        problems.push(`${input}: external import \`${spec}\` cannot load in a single-file bundle`);
      }
      if (!owner || !isBare(spec)) continue;
      if (!declaredDependencies(owner.manifest).has(name) && !hostProvided) {
        problems.push(
          `${input}: imports \`${name}\`, which ${owner.manifest.name} does not declare (phantom dependency)`,
        );
      }
      if (portable && !name.startsWith('@murmo/') && !portableAllowlist.has(name)) {
        problems.push(`${input}: \`${name}\` is not on the portable allowlist`);
      }
    }
  }
  return problems;
}

/** Load the bundle where Node, Bun, WebAssembly, eval and Intl.Segmenter are absent. */
export async function dynamicProblems({ code, format }) {
  const script = format === 'iife' ? code : (await transform(code, { format: 'iife', globalName: '__bundle' })).code;
  const problems = [];
  const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
  runInContext('delete globalThis.WebAssembly; if (globalThis.Intl) delete Intl.Segmenter;', context);
  try {
    runInContext(script, context, { timeout: 5000 });
  } catch (error) {
    // Errors come from another realm, so `instanceof Error` would be false.
    problems.push(`load in restricted realm failed: ${/** @type {any} */ (error)?.message ?? error}`);
  }
  if (format === 'iife') {
    const vm = (await getQuickJS()).newContext();
    try {
      const result = vm.evalCode(code);
      if (result.error) {
        problems.push(`load in QuickJS failed: ${JSON.stringify(vm.dump(result.error))}`);
        result.error.dispose();
      } else result.value.dispose();
    } finally {
      vm.dispose();
    }
  }
  return problems;
}

export async function checkBundle({ file, metafileFile, format, packages, portable }) {
  const code = readFileSync(file, 'utf8');
  const metafile = JSON.parse(readFileSync(metafileFile, 'utf8'));
  return [...staticProblems({ code, metafile, packages, portable }), ...(await dynamicProblems({ code, format }))];
}

// esbuild keeps license comments at the end of the file (`legalComments: 'eof'`).
function stripLegalComments(code) {
  return code.replace(/\/\*![\s\S]*?\*\/|\/\/[!@].*$/gm, '');
}

function isBare(spec) {
  return !spec.startsWith('.') && !spec.startsWith('/') && !/^[a-z]+:/.test(spec);
}

function ownerOf(input, packages) {
  if (input.includes('node_modules')) return undefined;
  const abs = `${root}${sep}${input}`;
  return packages.find((p) => !relative(p.dir, abs).startsWith('..'));
}

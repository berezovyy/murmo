// License gate for every JS and Rust dependency. Murmo's packages must stay
// permissive: GPL code is ideas only and CC BY-SA data must not enter them
// (knowledge § 11). An expression passes if one OR branch has only allowed ids.
import { execFileSync } from 'node:child_process';
import { cargoBinary, targetDir } from './cargo.mjs';
import { root } from './workspace.mjs';

/** Allowed SPDX ids, each with where it comes from. */
export const allowed = new Map([
  ['MIT', 'most JS and Rust dependencies'],
  ['Apache-2.0', 'TypeScript, Rust crates'],
  ['BSD-2-Clause', 'permissive'],
  ['BSD-3-Clause', 'smol-toml'],
  ['ISC', 'permissive'],
  ['Unicode-3.0', 'Unicode data tables in Rust crates'],
  ['Zlib', 'foldhash, via rquickjs'],
]);

/** Parses `A OR (B AND C) WITH X` and reports whether it can be satisfied. */
export function permits(expression, ids = allowed) {
  const tokens = expression.replace(/[()]/g, ' $& ').trim().split(/\s+/);
  let at = 0;
  const peek = () => tokens[at];
  const or = () => {
    let ok = and();
    while (peek() === 'OR') {
      at++;
      ok = and() || ok;
    }
    return ok;
  };
  const and = () => {
    let ok = term();
    while (peek() === 'AND') {
      at++;
      ok = term() && ok;
    }
    return ok;
  };
  const term = () => {
    const token = tokens[at++];
    if (token === '(') {
      const ok = or();
      if (tokens[at++] !== ')') throw new Error(`unbalanced license expression "${expression}"`);
      return ok;
    }
    if (!token || /^(AND|OR|WITH|\))$/.test(token)) throw new Error(`bad license expression "${expression}"`);
    if (peek() === 'WITH') {
      at += 2;
      return ids.has(token) && tokens[at - 1] === 'LLVM-exception';
    }
    return ids.has(token);
  };
  const ok = or();
  if (at !== tokens.length) throw new Error(`bad license expression "${expression}"`);
  return ok;
}

export function jsDependencies() {
  const json = JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--json'], { cwd: root, encoding: 'utf8' }));
  return Object.values(json)
    .flat()
    .flatMap((p) => p.versions.map((version) => ({ ecosystem: 'npm', name: p.name, version, license: p.license })));
}

export function rustDependencies() {
  const out = execFileSync(cargoBinary(), ['metadata', '--format-version', '1', '--locked', '--offline'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CARGO_TARGET_DIR: targetDir() },
    maxBuffer: 64 << 20,
  });
  const meta = JSON.parse(out);
  const members = new Set(meta.workspace_members);
  return meta.packages
    .filter((p) => !members.has(p.id))
    .map((p) => ({ ecosystem: 'crates', name: p.name, version: p.version, license: p.license ?? '' }));
}

export function violations(dependencies) {
  return dependencies.filter((d) => {
    try {
      return !d.license || !permits(d.license);
    } catch {
      return true;
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const deps = [...jsDependencies(), ...rustDependencies()];
  const bad = violations(deps);
  for (const d of bad) console.error(`FAIL ${d.ecosystem} ${d.name}@${d.version}: "${d.license || 'no license'}"`);
  console.log(`${deps.length} dependencies checked, ${bad.length} not allowed`);
  if (bad.length) process.exitCode = 1;
}

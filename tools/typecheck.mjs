// Type-checks every package (each with its own lib and types: portable
// packages get no Node types, so a Node API use fails here) and the tools.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { listPackages, root } from './workspace.mjs';

const tsc = join(root, 'node_modules', '.bin', 'tsc');
const projects = [join(root, 'tsconfig.tools.json')];
for (const pkg of listPackages()) {
  // `src/node/`: the Node/Bun side of a portable package (`murmo.nodeOnly`),
  // checked with Node types while the package's own tsconfig excludes it.
  for (const name of ['tsconfig.json', 'src/node/tsconfig.json', 'test/tsconfig.json']) {
    const file = join(pkg.dir, name);
    if (existsSync(file)) projects.push(file);
  }
}

let failed = false;
for (const project of projects) {
  const run = spawnSync(tsc, ['-p', project], { cwd: root, encoding: 'utf8' });
  if (run.status !== 0) {
    failed = true;
    console.error(`FAIL ${relative(root, project)}\n${run.stdout}${run.stderr}`);
  }
}
console.log(`${projects.length} projects type-checked${failed ? ', with errors' : ''}`);
process.exitCode = failed ? 1 : 0;

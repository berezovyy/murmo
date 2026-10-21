// Measurement outputs live in .runs/<measurement>/<attempt>/. AGENTS.md keeps
// only the newest 3 attempts of a measurement; numbers that matter go into
// docs/knowledge.md before older attempts are deleted.
//
//   node tools/runs.mjs new <measurement>   prints the new attempt folder
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './workspace.mjs';

export const keep = 3;

export function newRun(measurement, { base = join(root, '.runs'), now = new Date() } = {}) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(measurement)) throw new Error(`bad measurement name "${measurement}"`);
  const dir = join(base, measurement);
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let attempt = join(dir, stamp);
  for (let n = 2; existing(dir).includes(attemptName(attempt)); n++) attempt = join(dir, `${stamp}-${n}`);
  mkdirSync(attempt);
  for (const old of existing(dir).slice(0, -keep)) rmSync(join(dir, old), { recursive: true, force: true });
  return attempt;
}

// ISO timestamps sort by time as plain strings.
function existing(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function attemptName(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, measurement] = process.argv.slice(2);
  if (command !== 'new' || !measurement) {
    console.error('usage: node tools/runs.mjs new <measurement>');
    process.exitCode = 2;
  } else console.log(newRun(measurement));
}

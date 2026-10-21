// Runs every JS unit test. Refuses to start unless the network is blocked, so
// no test can reach a real provider (lessons 44, 53). Use `pnpm test`, which
// goes through tools/offline/run.sh.
import { spawnSync } from 'node:child_process';
import { probe } from './offline/probe.mjs';
import { root } from './workspace.mjs';

const offline = await probe();
if (!offline.offline) {
  console.error(`refusing to run tests with network access (${offline.reason}); use pnpm test`);
  process.exit(1);
}

const patterns = ['tools/test/**/*.test.mjs', 'packages/**/test/**/*.test.ts', 'fixtures/test/**/*.test.ts'];
const run = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...patterns], {
  cwd: root,
  stdio: 'inherit',
});
process.exitCode = run.status ?? 1;

// Child-process entry for runtimes that run TypeScript directly (Bun): reads
// a GuestRequest file, runs the pure suites, prints the RunResult as JSON.
//
//   bun packages/conformance/src/node/guest-cli.ts <request.json>

import { readFileSync } from 'node:fs';
import { type GuestRequest, runPure } from '../guest.ts';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('usage: guest-cli.ts <request.json>');
  process.exit(2);
}
const request = JSON.parse(readFileSync(file, 'utf8')) as GuestRequest;
process.stdout.write(JSON.stringify(runPure(request)));

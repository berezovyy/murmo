// Child-process entry for runtimes that run TypeScript directly (Bun): reads
// a GuestRequest file, runs the pure suites (or, with --core, the core
// subject), prints the RunResult as JSON.
//
//   bun packages/conformance/src/node/guest-cli.ts [--core] <request.json>

import { readFileSync } from 'node:fs';
import { loadEnglishPack } from '@murmo/plugin-autocorrect/node';
import { type GuestRequest, runCore, runPure } from '../guest.ts';

loadEnglishPack();

const args = process.argv.slice(2);
const core = args.includes('--core');
const file = args.find((a) => a !== '--core');
if (!file) {
  console.error('usage: guest-cli.ts [--core] <request.json>');
  process.exit(2);
}
const request = JSON.parse(readFileSync(file, 'utf8')) as GuestRequest;
const result = core ? await runCore(request, () => performance.now()) : runPure(request);
process.stdout.write(JSON.stringify(result));

#!/usr/bin/env node
// murmo-lang-en: build, verify and gate the English language pack.
//
//   murmo-lang-en build [--out DIR]           build from inputs/ into DIR (default dist/pack)
//   murmo-lang-en verify [--pack DIR]         independent verifier over a built pack
//   murmo-lang-en gate [--pack DIR] [--summary FILE] [--oracle NAME=PATH ...]
//                                             evaluation gate; exits 1 on a regression
//   murmo-lang-en pin                         re-pin inputs/sources.json to the current input bytes
//   murmo-lang-en freeze-project-terms --out FILE CACHE.json ...
//                                             re-extract the protected project terms (maintainers)
//
// `gate` without --pack builds (or reuses) dist/pack first. --summary appends
// the Markdown report to FILE.

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { mapTable } from '@murmo/lang';
import { buildPack } from './build.ts';
import { formatGate, r6Dictionary, runGate } from './gate/index.ts';
import { readOracle, scoreOracle } from './gate/oracles.ts';
import { defaultPackDir, ensurePack } from './index.ts';
import { loadInputs, pinInputs } from './inputs.ts';
import { PACK_FILES } from './policy.ts';
import { freezeProjectTerms } from './project-terms.ts';
import { verifyPack } from './verify.ts';

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      pack: { type: 'string' },
      summary: { type: 'string' },
      oracle: { type: 'string', multiple: true },
    },
  });
  switch (command) {
    case 'build': {
      const { receipt: _receipt, ...report } = buildPack(values.out ?? defaultPackDir);
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    case 'verify': {
      console.log(JSON.stringify(verifyPack(values.pack ?? ensurePack()), null, 2));
      return 0;
    }
    case 'gate': {
      const pack = values.pack ?? ensurePack();
      const table = mapTable(new Uint8Array(readFileSync(join(pack, PACK_FILES.table))));
      const result = runGate(table, r6Dictionary(loadInputs()));
      let report = formatGate(result);
      for (const spec of values.oracle ?? []) {
        const [name, path] = spec.split('=', 2);
        if (!name || !path) throw new Error(`--oracle wants NAME=PATH, got "${spec}"`);
        const s = scoreOracle(table, name, readOracle(path));
        report += `\nOracle ${s.name} (advisory, ${s.keys.toLocaleString('en-US')} keys): ${s.agree} agree, ${s.disagree} disagree\n`;
      }
      process.stdout.write(report);
      if (values.summary) appendFileSync(values.summary, report);
      return result.failures.length ? 1 : 0;
    }
    case 'pin': {
      const pinned = pinInputs();
      for (const p of pinned.inputs) console.log(`${p.sha256}  ${p.file}`);
      return 0;
    }
    case 'freeze-project-terms': {
      if (!values.out || positionals.length === 0)
        throw new Error('usage: freeze-project-terms --out FILE CACHE.json ...');
      console.log(`${freezeProjectTerms(positionals, values.out)} terms written to ${values.out}`);
      return 0;
    }
    default:
      console.error('usage: murmo-lang-en build|verify|gate|pin|freeze-project-terms (see src/cli.ts)');
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));

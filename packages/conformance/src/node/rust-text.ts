// The Rust leg of the offset parity check (docs/plan/04 task 7): the seeded
// unicode corpus with the verdicts @murmo/text gives in JavaScript, checked by
// `packages/js-runtime/tests/text_parity.rs` against Rust's
// `unicode-segmentation` (the crate the Codex wrapper pins). The fixed
// `fixtures/text/` cases are read by that test directly.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GeneratorFile, PureCase } from '@murmo/fixtures';
import { unicode } from '@murmo/fixtures/generators';
import { textFunctions } from '../fns/text.ts';
import { repoRoot } from './fixtures.ts';

export interface RustTextParity {
  drafts: number;
}

/** Writes the corpus as `text.offsets` cases and runs the Rust test on it; throws on any difference. */
export function runRustTextParity(generator: GeneratorFile, size: number): RustTextParity {
  const offsets = textFunctions['text.offsets'];
  if (typeof offsets !== 'function') throw new Error('text.offsets is not registered');
  const cases: PureCase[] = [];
  for (const generated of unicode.generate(generator.seed, size)) {
    const input = { text: (generated.case.input as { text: string }).text };
    cases.push({ id: generated.case.id, input, output: offsets(input) });
  }
  const dir = mkdtempSync(join(tmpdir(), 'murmo-text-parity-'));
  try {
    const corpus = join(dir, 'corpus.json');
    writeFileSync(corpus, JSON.stringify({ kind: 'pure-fn/v1', offsets: 'utf16', fn: 'text.offsets', cases }));
    const args = ['tools/cargo.mjs', 'test', '--quiet', '--offline', '--locked', '-p', 'murmo-js-runtime'];
    const run = spawnSync(process.execPath, [...args, '--test', 'text_parity', '--', '--nocapture'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, MURMO_TEXT_CORPUS: corpus },
      maxBuffer: 64 << 20,
    });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`rust text parity failed:\n${(run.stdout + run.stderr).slice(-4000)}`);
    const match = /text parity: (\d+) generated drafts agree/.exec(run.stdout);
    if (!match || Number(match[1]) !== cases.length) {
      throw new Error(`rust text parity compared ${match?.[1] ?? 'nothing'}, expected ${cases.length} drafts`);
    }
    return { drafts: cases.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

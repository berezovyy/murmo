// The evaluation gate (docs/plan/12): runs on every data change and blocks a
// regression. Limits live in gate.json; the report is a Markdown table.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookup, type PackedTable } from '@murmo/lang';
import { type Inputs, packageDir } from '../inputs.ts';
import { type CleanScore, type SlipScore, scoreClean, scoreSlips } from './evaluate.ts';
import { fixturesDir, r6SlipStream, readCounts, readFastTyping } from './streams.ts';

export interface GateConfig {
  readonly clean: { readonly set: string; readonly maxWrong: number };
  readonly heldOut: { readonly set: string; readonly maxWrong: number; readonly minApplied: number };
  readonly round6: { readonly set: string; readonly seed: number; readonly draws: number; readonly maxWrong: number };
  readonly required: Readonly<Record<string, string>>;
  readonly round8: {
    readonly clean: { readonly wrong: number };
    readonly heldOut: Omit<SlipScore, 'wrongExamples'>;
    readonly round6: Omit<SlipScore, 'wrongExamples'>;
  };
}

export const readGateConfig = (): GateConfig =>
  JSON.parse(readFileSync(join(packageDir, 'gate.json'), 'utf8')) as GateConfig;

export interface GateResult {
  readonly clean: CleanScore;
  readonly heldOut: SlipScore;
  readonly round6: SlipScore;
  /** Required examples the table gets wrong, as `typo → got (want)`. */
  readonly requiredMisses: readonly string[];
  /** One line per broken limit; empty when the gate passes. */
  readonly failures: readonly string[];
}

/** Round 6 drew its slip sources from the system dictionary, lowercased: the frozen web2 input. */
export const r6Dictionary = (inputs: Inputs): Set<string> => new Set(inputs.web2.map((w) => w.toLowerCase()));

/** `dictionary`: `r6Dictionary(inputs)`. */
export function runGate(
  table: PackedTable,
  dictionary: ReadonlySet<string>,
  config = readGateConfig(),
  dir = fixturesDir,
): GateResult {
  const clean = scoreClean(table, readCounts(config.clean.set, dir));
  const heldOut = scoreSlips(table, readFastTyping(config.heldOut.set, dir));
  const stream = r6SlipStream(readCounts(config.round6.set, dir), dictionary, config.round6.seed, config.round6.draws);
  const round6 = scoreSlips(
    table,
    stream.map((e) => e.slip),
  );
  const requiredMisses = Object.entries(config.required)
    .filter(([typo, want]) => lookup(table, typo) !== want)
    .map(([typo, want]) => `${typo} → ${lookup(table, typo) ?? '(none)'} (want ${want})`);
  const failures: string[] = [];
  if (clean.wrong > config.clean.maxWrong)
    failures.push(`clean text: ${clean.wrong} wrong fixes (limit ${config.clean.maxWrong})`);
  if (heldOut.wrong > config.heldOut.maxWrong)
    failures.push(`held-out slips: ${heldOut.wrong} wrong fixes (limit ${config.heldOut.maxWrong})`);
  if (heldOut.applied < config.heldOut.minApplied)
    failures.push(`held-out slips: ${heldOut.applied} fixes applied (at least ${config.heldOut.minApplied})`);
  if (round6.wrong > config.round6.maxWrong)
    failures.push(`round-6 slips: ${round6.wrong} wrong fixes (limit ${config.round6.maxWrong})`);
  for (const miss of requiredMisses) failures.push(`required example: ${miss}`);
  return { clean, heldOut, round6, requiredMisses, failures };
}

/** The gate as a Markdown table, round 8's numbers alongside. */
export function formatGate(result: GateResult, config = readGateConfig(), title = 'Language data gate (en)'): string {
  const r8 = config.round8;
  const row = (check: string, value: number, limit: string, round8: number | string) =>
    `| ${check} | ${value.toLocaleString('en-US')} | ${limit} | ${typeof round8 === 'number' ? round8.toLocaleString('en-US') : round8} |`;
  const lines = [
    `### ${title}: ${result.failures.length ? 'FAIL' : 'pass'}`,
    '',
    '| Check | Result | Limit | Round 8 |',
    '|---|---:|---:|---:|',
    row(
      `Clean text (${result.clean.tokens.toLocaleString('en-US')} words): wrong fixes`,
      result.clean.wrong,
      `≤ ${config.clean.maxWrong}`,
      r8.clean.wrong,
    ),
    row(
      `Held-out slips, seed 8004 (${result.heldOut.events.toLocaleString('en-US')}): wrong`,
      result.heldOut.wrong,
      `≤ ${config.heldOut.maxWrong}`,
      r8.heldOut.wrong,
    ),
    row(
      'Held-out slips, seed 8004: applied',
      result.heldOut.applied,
      `≥ ${config.heldOut.minApplied.toLocaleString('en-US')}`,
      r8.heldOut.applied,
    ),
    row('Held-out slips, seed 8004: correct', result.heldOut.correct, '', r8.heldOut.correct),
    row(
      `Round-6 slips, seed 6002 (${result.round6.events.toLocaleString('en-US')}): wrong`,
      result.round6.wrong,
      `≤ ${config.round6.maxWrong}`,
      r8.round6.wrong,
    ),
    row('Round-6 slips, seed 6002: correct', result.round6.correct, '', r8.round6.correct),
    row(
      'Required examples correct',
      Object.keys(config.required).length - result.requiredMisses.length,
      `${Object.keys(config.required).length}`,
      11,
    ),
  ];
  if (result.failures.length) lines.push('', ...result.failures.map((f) => `- **${f}**`));
  const wrong = [...result.heldOut.wrongExamples, ...result.round6.wrongExamples].slice(0, 12);
  if (wrong.length) {
    lines.push('', '<details><summary>Wrong fixes (typed → fix, intended)</summary>', '');
    for (const w of wrong) lines.push(`- \`${w.typed}\` → \`${w.fix}\`, meant \`${w.intended}\` (${w.count}×)`);
    lines.push('', '</details>');
  }
  return `${lines.join('\n')}\n`;
}

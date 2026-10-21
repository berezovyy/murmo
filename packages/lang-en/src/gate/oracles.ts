// Public typo lists as hidden oracles (docs/plan/12): never build inputs, and
// never in this repo (their data is partly CC BY-SA, knowledge § 11). A
// maintainer who has a list locally can compare the table with it; the report
// is advisory, not a gate. Formats: typos/codespell/misspell CSV
// (`typo,correction[,correction…]`) and Wikipedia's `typo->correction, …`.

import { readFileSync } from 'node:fs';
import { lookup, type PackedTable } from '@murmo/lang';

export interface OracleScore {
  readonly name: string;
  readonly keys: number;
  /** Keys the table also has, with a correction the oracle lists. */
  readonly agree: number;
  /** Keys the table also has, with a correction the oracle doesn't list. */
  readonly disagree: number;
  readonly disagreements: readonly {
    readonly typo: string;
    readonly ours: string;
    readonly oracle: readonly string[];
  }[];
}

export function readOracle(path: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.includes('->')) {
      const [typo, rest] = line.split('->', 2) as [string, string];
      out.set(
        typo.trim().toLowerCase(),
        rest.split(',').map((v) => v.trim().toLowerCase()),
      );
    } else if (line.includes(',')) {
      const [typo, ...fixes] = line.split(',');
      if (typo)
        out.set(
          typo.trim(),
          fixes.map((v) => v.trim()),
        );
    }
  }
  return out;
}

export function scoreOracle(
  table: PackedTable,
  name: string,
  oracle: ReadonlyMap<string, readonly string[]>,
): OracleScore {
  let agree = 0;
  let disagree = 0;
  const disagreements: { typo: string; ours: string; oracle: readonly string[] }[] = [];
  for (const [typo, fixes] of oracle) {
    const ours = lookup(table, typo);
    if (ours === undefined) continue;
    if (fixes.includes(ours)) agree++;
    else {
      disagree++;
      if (disagreements.length < 30) disagreements.push({ typo, ours, oracle: fixes });
    }
  }
  return { name, keys: oracle.size, agree, disagree, disagreements };
}

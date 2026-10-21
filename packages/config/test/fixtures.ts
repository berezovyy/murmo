// Reads phase 14's cases from fixtures/config/ (the shared fixture format,
// docs/plan/02) for the config tests and tools/config-parity.mjs.
import { readFileSync } from 'node:fs';
import { expandInput, type FixtureInput, type TomlCase } from './parity-cases.ts';

export const fixturesDir = new URL('../../../fixtures/', import.meta.url);

export interface FixtureCase<Input = unknown, Output = unknown> {
  readonly id: string;
  readonly tags?: readonly string[];
  readonly note?: string;
  readonly input: Input;
  readonly output: Output;
}

/** The cases of one fixtures/config/ file. */
export function fixtureCases<Input = unknown, Output = unknown>(file: string): FixtureCase<Input, Output>[] {
  const data = JSON.parse(readFileSync(new URL(`config/${file}`, fixturesDir), 'utf8')) as {
    cases: FixtureCase<Input, Output>[];
  };
  return data.cases;
}

/** The `config.parse` cases of one file, with their text expanded. */
export function configCases(file: 'toml-corpus.json' | 'hostile.json' | 'schema.json'): TomlCase[] {
  return fixtureCases<FixtureInput>(file).map((c) => {
    const valid = c.tags?.includes('toml-valid') ? true : c.tags?.includes('toml-invalid') ? false : undefined;
    return {
      name: c.id,
      source: expandInput(c.input),
      ...(c.input.origin ? { origin: c.input.origin } : {}),
      ...(valid === undefined ? {} : { valid }),
      output: c.output,
    };
  });
}

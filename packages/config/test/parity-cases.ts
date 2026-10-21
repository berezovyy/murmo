// Evaluates TOML cases with @murmo/config for tools/config-parity.mjs, which
// compares every result with the Rust twin (rust/examples/config-parity.rs).
// The cases are fixtures/config/*.json (pure-fn/v1, fn config.parse); the
// four JavaScript runtimes are compared on them by packages/conformance.
import type { TextSpec } from '@murmo/fixtures';
import { parse } from 'smol-toml';
import { type ConfigOrigin, normalizeToml, parseConfig } from '../src/index.ts';

/** A `config.parse` fixture input (packages/conformance/src/fns/config.ts reads the same shape). */
export interface FixtureInput {
  readonly source: TextSpec;
  /** Lines appended after `source`: `template` with each `{i}` replaced by 0 … count-1. */
  readonly numbered?: { readonly template: string; readonly count: number };
  readonly origin?: ConfigOrigin;
}

function resolveText(spec: TextSpec): string {
  if (typeof spec === 'string') return spec;
  if (Array.isArray(spec)) return spec.map(resolveText).join('');
  return spec.repeat.repeat(spec.times);
}

/** The file text a fixture input stands for. */
export function expandInput(input: FixtureInput): string {
  let text = resolveText(input.source);
  const numbered = input.numbered;
  if (numbered) for (let i = 0; i < numbered.count; i++) text += numbered.template.split('{i}').join(String(i));
  return text;
}

/** One fixture case with its file text expanded. */
export interface TomlCase {
  readonly name: string;
  readonly source: string;
  readonly origin?: ConfigOrigin;
  /** Whether r8 measured the file as valid TOML (corpus cases, tags `toml-valid` / `toml-invalid`). */
  readonly valid?: boolean;
  /** The fixture's expected `config.parse` summary. */
  readonly output?: unknown;
}

export function sourceOf(c: TomlCase): string {
  return c.source;
}

/** TOML data as JSON; a datetime becomes a marker, since the two parsers print them differently. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Date) return { $datetime: true };
  if (typeof value === 'bigint') return { $bigint: String(value) };
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, { value: plain(v), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

export interface CaseResult {
  readonly name: string;
  readonly toml: unknown;
  readonly config: unknown;
}

export function run(file: { readonly cases: readonly TomlCase[] }): CaseResult[] {
  return file.cases.map((c) => {
    const source = sourceOf(c);
    const origin = c.origin ?? 'user';
    const config = parseConfig(source, { file: `${c.name}.toml`, origin });
    // Files refused before parsing never reach a parser, so there is no value to compare.
    const refused = config.diagnostics.some((d) => d.code === 'too-large' || d.code === 'too-deep');
    let toml: unknown = null;
    if (!refused) {
      try {
        toml = plain(parse(normalizeToml(source), { integersAsBigInt: 'asNeeded' }));
      } catch {
        toml = null;
      }
    }
    return { name: c.name, toml, config: JSON.parse(JSON.stringify(config)) };
  });
}

// The one TOML entry point in JS: smol-toml on every JS host, Bun included,
// because Bun's built-in parser reports the JavaScript call site instead of the
// TOML line (lesson 27, r8 § 53). The build gate and Biome refuse Bun's parser.
import { parse, TomlError } from 'smol-toml';
import type { Position } from './diagnostics.ts';
import { parserPosition } from './source.ts';

export type TomlTable = Record<string, unknown>;

export type TomlParse =
  | { readonly ok: true; readonly table: TomlTable }
  | { readonly ok: false; readonly at: Position; readonly message: string };

/**
 * Parses an already normalized source. An integer beyond 2^53 comes back as a
 * BigInt instead of failing the whole file (smol-toml's default), so the file
 * loads like it does in Rust `toml` and only that value is refused
 * (schema.ts `toJson`). 'asNeeded' costs nothing measurable on a
 * 1,000-shortcut file (p50 0.236 vs 0.233 ms).
 */
export function parseToml(source: string): TomlParse {
  try {
    return { ok: true, table: parse(source, { integersAsBigInt: 'asNeeded' }) as TomlTable };
  } catch (error) {
    if (error instanceof TomlError) {
      // The first line of the message is the reason; the rest is smol-toml's code block.
      const reason = error.message.split('\n', 1)[0]?.replace(/^Invalid TOML document: /, '') ?? 'invalid TOML';
      return { ok: false, at: parserPosition(source, error.line, error.column), message: reason };
    }
    // A RangeError from a runaway input would land here; the nesting bound
    // runs first, so this is a parser bug, reported as a parse error at 1:1.
    return { ok: false, at: { line: 1, column: 1 }, message: String((error as Error)?.message ?? error) };
  }
}

// Pure functions over @murmo/config for fixtures/config/ (phase 14): the r8
// TOML corpus, the r12 hostile files and one snippet per schema branch, parsed
// and validated the same way on Node, Bun, QuickJS-wasm and rquickjs. The Rust
// twin reads the same files in tools/config-parity.mjs. Repository cases
// (fixtures/config/trust.json, `config.trust`) need a file system, so the pure
// subject skips them; packages/config/test/trust.test.ts runs them.

import { type ConfigFile, type ConfigOrigin, parseConfig } from '@murmo/config';
import type { TextSpec } from '@murmo/fixtures';
import { sha256 } from '@murmo/fixtures/generators';
import type { PureEntry } from '../pure.ts';
import { resolveText } from '../values.ts';

export interface ConfigCaseInput {
  /** The file text. */
  source: TextSpec;
  /** Lines appended after `source`: `template` with each `{i}` replaced by 0 … count-1. */
  numbered?: { template: string; count: number };
  origin?: ConfigOrigin;
}

/** The file text a case stands for. */
export function configSource(input: ConfigCaseInput): string {
  let text = resolveText(input.source);
  const numbered = input.numbered;
  if (numbered) for (let i = 0; i < numbered.count; i++) text += numbered.template.split('{i}').join(String(i));
  return text;
}

/** Shortcut lists longer than this are compared by count and hash, so outputs stay small. */
const LISTED_SHORTCUTS = 50;

/**
 * What a file loads, without wording: status, every diagnostic's code and
 * position, the shortcuts and the other settings. Messages and excerpts are
 * checked by the unit tests in packages/config, not pinned here.
 */
export function configSummary(file: ConfigFile): unknown {
  const shortcuts = file.shortcuts.map((s) => [s.shortcut, s.kind === 'text' ? s.text : { file: s.path }]);
  const out: Record<string, unknown> = {
    status: file.status,
    diagnostics: file.diagnostics.map((d) => ({
      code: d.code,
      severity: d.severity,
      line: d.line,
      column: d.column,
    })),
    shortcuts:
      shortcuts.length > LISTED_SHORTCUTS
        ? { count: shortcuts.length, sha256: sha256(JSON.stringify(shortcuts)) }
        : shortcuts,
  };
  if (file.language !== undefined) out.language = file.language;
  if (file.protect.length) out.protect = file.protect;
  if (file.autocorrect !== undefined) out.autocorrect = file.autocorrect;
  if (file.pluginOrder !== undefined) out.pluginOrder = file.pluginOrder;
  if (file.private !== undefined) out.private = file.private;
  const plugins = Object.entries(file.plugins);
  if (plugins.length) {
    out.plugins = Object.fromEntries(
      plugins.map(([id, p]) => [
        id,
        p.enabled === undefined ? { settings: p.settings } : { enabled: p.enabled, settings: p.settings },
      ]),
    );
  }
  return out;
}

function parse(input: unknown): unknown {
  const c = input as ConfigCaseInput;
  const origin = c.origin ?? 'user';
  return configSummary(parseConfig(configSource(c), { file: `${origin}.toml`, origin }));
}

export const configFunctions: Readonly<Record<string, PureEntry>> = {
  'config.parse': parse,
};

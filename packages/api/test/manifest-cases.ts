// Evaluates manifest-cases.json. Portable on purpose (no Node APIs): the same
// file is bundled for QuickJS-wasm, rquickjs and Bun by test/portable-parity.ts,
// so every runtime computes its verdicts with this code and the API's own.
//
// The JSON uses the pure-fn/v1 shape planned in phase 02 so it can move to
// fixtures/api/manifest/ unchanged once that runner lands.

import type { Capabilities, PluginManifest } from '../src/index.ts';
import { negotiate, parseManifest, resolveSettings, satisfies, validateManifest } from '../src/index.ts';

export interface ManifestCase {
  readonly id: string;
  readonly fn: 'validateManifest' | 'parseManifest' | 'satisfies' | 'resolveSettings' | 'negotiate';
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: Outcome;
  readonly reason: string;
}

export interface CaseFile {
  readonly base: Record<string, unknown>;
  readonly caps: Readonly<Record<string, Capabilities>>;
  readonly cases: readonly ManifestCase[];
}

export type Outcome = { readonly ok: unknown } | { readonly error: { readonly code: string; readonly path: string } };

export type Verdict = Outcome & { readonly id: string };

/** The base manifest with top-level keys replaced; a `null` value removes the key. */
function patched(base: Record<string, unknown>, patch: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries((patch ?? {}) as Record<string, unknown>)) {
    if (value === null) delete out[key];
    else Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function evaluate(file: CaseFile, c: ManifestCase): unknown {
  const input = c.input;
  const manifest = () => patched(file.base, input.patch);
  switch (c.fn) {
    case 'validateManifest':
      validateManifest('value' in input ? input.value : manifest());
      return true;
    case 'parseManifest': {
      if (typeof input.text === 'string') return Boolean(parseManifest(input.text));
      const m = manifest() as { settingsSchema: { properties: Record<string, Record<string, unknown>> } };
      const pad = String(input.padChar).repeat(Number(input.padUnits));
      const enabled = m.settingsSchema.properties.enabled ?? {};
      m.settingsSchema.properties.enabled = { ...enabled, description: pad };
      return Boolean(parseManifest(JSON.stringify(m)));
    }
    case 'satisfies':
      return satisfies(String(input.core), String(input.range));
    case 'resolveSettings':
      return resolveSettings(validateManifest(manifest()), input.settings as Readonly<Record<string, unknown>>);
    case 'negotiate': {
      const caps = file.caps[String(input.caps)];
      if (!caps) throw new Error(`unknown caps fixture ${String(input.caps)}`);
      return negotiate(manifest() as unknown as PluginManifest, caps);
    }
  }
}

/** One verdict per case, in file order; a non-manifest error is reported as `unexpected`. */
export function run(file: CaseFile): Verdict[] {
  return file.cases.map((c): Verdict => {
    try {
      return { id: c.id, ok: evaluate(file, c) };
    } catch (error) {
      const e = error as { code?: unknown; path?: unknown; message?: unknown };
      if (typeof e.code === 'string' && typeof e.path === 'string')
        return { id: c.id, error: { code: e.code, path: e.path } };
      return { id: c.id, error: { code: 'unexpected', path: String(e.message ?? error) } };
    }
  });
}

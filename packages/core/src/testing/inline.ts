// Test inline rule sets: the reviewed pairs the burst oracle knows, packed as
// a table, with the policy flags the registry requires. Phase 13 replaces the
// table with the English pack; the interpreter does not change.

import type { PluginFactory } from '@murmo/api';
import type { InlineRules } from '@murmo/api/adapter';
import { encodeTable, mapTable } from '@murmo/lang';
import { ENGLISH_POLICY, REQUIRED_SKIP, type TableReceipt } from '../inline/index.ts';
import type { DirectPluginSpec } from './direct-runner.ts';

/** Same pairs as `fixtures/generators/burst.ts`; the oracle and the test table share them. */
export const REVIEWED_PAIRS: readonly (readonly [string, string])[] = [
  ['teh', 'the'],
  ['adn', 'and'],
  ['recieve', 'receive'],
  ['adress', 'address'],
  ['i', 'I'],
];

export function testTableBytes(pairs: Iterable<readonly [string, string]> = REVIEWED_PAIRS): Uint8Array {
  return encodeTable(pairs);
}

export interface TestInlineOptions {
  readonly id?: string;
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly replacements?: Readonly<Record<string, string>>;
  readonly vocabulary?: readonly string[];
  readonly inlineMaxInsertBytes?: number;
  readonly maxInsertBytes?: number;
  readonly asset?: string;
  readonly sha256?: string;
}

export interface TestInlineBundle {
  readonly rules: InlineRules;
  readonly assets: Readonly<Record<string, ArrayBuffer>>;
  readonly receipt: TableReceipt;
}

export function testInlineRules(owner: string, options: TestInlineOptions = {}): TestInlineBundle {
  const bytes = testTableBytes();
  const table = mapTable(bytes);
  const asset = options.asset ?? 'english.bin';
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  if (!(copy.buffer instanceof ArrayBuffer)) throw new TypeError('table bytes need an ArrayBuffer');
  const rules: InlineRules = {
    id: options.id ?? 'english',
    owner,
    priority: options.priority ?? 0,
    enabled: options.enabled ?? true,
    policy: ENGLISH_POLICY,
    table: {
      format: 'packed-sorted-ascii-v1',
      asset,
      sha256: options.sha256 ?? 'test',
      entries: table.entries,
    },
    language: 'en',
    boundaries: ' .,;:!?',
    case: 'preserve-title',
    dot: 'wait-next-typed-key',
    origin: 'fully-typed-span',
    skip: [...REQUIRED_SKIP],
    ...(options.replacements ? { replacements: { format: 'literal-utf8-v1', entries: options.replacements } } : {}),
    ...(options.vocabulary ? { vocabulary: options.vocabulary } : {}),
    inlineMaxInsertBytes: options.inlineMaxInsertBytes ?? 1024,
    maxInsertBytes: options.maxInsertBytes ?? 16384,
    rejectMemory: 'per-draft',
  };
  return {
    rules,
    assets: { [asset]: copy.buffer },
    receipt: { sha256: options.sha256 ?? 'test', entries: table.entries, bytes: bytes.byteLength, formatVersion: 1 },
  };
}

const noopAutocorrect: PluginFactory = () => ({
  name: 'autocorrect',
  version: '1.0.0',
  permissions: ['draft:read', 'draft:write'],
});

/** A built-in plugin that only registers inline data; no async typo path. */
export function testInlinePlugin(
  id: string,
  options: TestInlineOptions & { readonly factory?: PluginFactory } = {},
): DirectPluginSpec {
  const { factory, ...rest } = options;
  const bundle = testInlineRules(id, rest);
  return {
    id,
    builtin: true,
    factory: factory ?? noopAutocorrect,
    inline: [bundle.rules],
    assets: bundle.assets,
  };
}

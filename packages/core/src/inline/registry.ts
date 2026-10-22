// Rule-set validation and table mapping. The packed reader is @murmo/lang's:
// validateTable at install, mapTable (+ receipt) at session start (lesson 66).
// Invalid data refuses that rule set with a notice; the plugin's async hooks
// still load (E6, E11).

import type { Permission } from '@murmo/api';
import type { InlineRules } from '@murmo/api/adapter';
import { lookup, mapTable, type PackedTable, TABLE_FORMAT, validateTable } from '@murmo/lang';
import { unsafeText, utf8Length } from '@murmo/text';
import { ENGLISH_POLICY, policyByName, type WordPolicy } from './policy.ts';

export const REQUIRED_SKIP = ['code', 'path', 'URL', 'flag', 'identifier', 'foreign-letter-line'] as const;
export const POLICY_BOUNDARIES = ' .,;:!?' as const;
export const DEFAULT_INLINE_MAX_BYTES = 1024;
export const MAX_INSERT_BYTES = 16384;
export const MAX_TABLE_ENTRIES = 100_000;
export const MAX_TABLE_BYTES = 4 * 1024 * 1024;
export const MAX_SHORTCUTS = 1000;
export const MAX_TRIGGER_POINTS = 32;

/** What full validation proved, so session start can skip the per-entry walk. */
export interface TableReceipt {
  readonly sha256: string;
  readonly entries: number;
  readonly bytes: number;
  readonly formatVersion: 1;
}

export type Sha256 = (bytes: Uint8Array) => string;

export interface RegisteredInline {
  readonly id: string;
  readonly owner: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly policy: WordPolicy;
  readonly table: PackedTable | undefined;
  readonly replacements: ReadonlyMap<string, string>;
  /** First-field UTF-16 offset in the expansion, when the shortcut is a template. */
  readonly fieldCursors: ReadonlyMap<string, number>;
  readonly vocabulary: ReadonlySet<string>;
  readonly inlineMaxBytes: number;
  readonly maxInsertBytes: number;
}

export class InlineRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InlineRegistrationError';
  }
}

const skipSet = new Set<string>(REQUIRED_SKIP);

function cloneData<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'function') throw new InlineRegistrationError('inline rules must contain data only');
      return item;
    }),
  ) as T;
}

const shortcutKey = /^[\p{L}\p{N};,\\=+][^\s]*$/u;

/**
 * Full table check for build, setup and doctor. Returns the receipt a session
 * later hands to `openTable`.
 */
export function receiptForTable(bytes: Uint8Array, sha256: Sha256): TableReceipt {
  if (bytes.byteLength > MAX_TABLE_BYTES) {
    throw new InlineRegistrationError(`inline table is ${bytes.byteLength} bytes, ceiling ${MAX_TABLE_BYTES}`);
  }
  const table = mapTable(bytes);
  if (table.entries < 1 || table.entries > MAX_TABLE_ENTRIES) {
    throw new InlineRegistrationError(`inline table has ${table.entries} entries, allowed 1..${MAX_TABLE_ENTRIES}`);
  }
  validateTable(table);
  return { sha256: sha256(bytes), entries: table.entries, bytes: bytes.byteLength, formatVersion: 1 };
}

/**
 * Session-start map: header, length and entry count against the receipt, no
 * per-entry walk. Pass `sha256` where the host has native hashing.
 */
export function openTable(bytes: Uint8Array, receipt: TableReceipt, sha256?: Sha256): PackedTable {
  if (bytes.byteLength !== receipt.bytes) {
    throw new InlineRegistrationError(`inline table is ${bytes.byteLength} bytes, receipt says ${receipt.bytes}`);
  }
  if (sha256 && sha256(bytes) !== receipt.sha256) {
    throw new InlineRegistrationError(`inline table SHA-256 is not ${receipt.sha256}`);
  }
  const table = mapTable(bytes);
  if (table.entries !== receipt.entries) {
    throw new InlineRegistrationError(`inline table has ${table.entries} entries, receipt says ${receipt.entries}`);
  }
  return table;
}

export interface RegisterContext {
  readonly owner: string;
  readonly builtin: boolean;
  readonly permissions: readonly Permission[];
  readonly assets?: Readonly<Record<string, ArrayBuffer>> | undefined;
  /** Transport cap from `caps.inline.maxBytes`; the effective inline limit is the min. */
  readonly transportMaxBytes: number;
  readonly sha256?: Sha256 | undefined;
  readonly receipts?: Readonly<Record<string, TableReceipt>> | undefined;
}

function checkFlags(rule: InlineRules): void {
  if (rule.language !== 'en') throw new InlineRegistrationError(`language ${JSON.stringify(rule.language)} is not en`);
  if (rule.boundaries !== POLICY_BOUNDARIES) throw new InlineRegistrationError('boundaries must be the policy set');
  if (rule.case !== 'preserve-title') throw new InlineRegistrationError('case must be preserve-title');
  if (rule.dot !== 'wait-next-typed-key') throw new InlineRegistrationError('dot must wait for the next typed key');
  if (rule.origin !== 'fully-typed-span') throw new InlineRegistrationError('origin must be fully-typed-span');
  if (rule.rejectMemory !== 'per-draft') throw new InlineRegistrationError('rejectMemory must be per-draft');
  if (REQUIRED_SKIP.some((flag) => !rule.skip.includes(flag)) || rule.skip.some((flag) => !skipSet.has(flag))) {
    throw new InlineRegistrationError('skip flags cannot weaken the policy');
  }
}

function replacementsOf(rule: InlineRules, maxInsertBytes: number): Map<string, string> {
  if (rule.replacements && rule.replacements.format !== 'literal-utf8-v1') {
    throw new InlineRegistrationError('invalid literal replacement format');
  }
  const entries = rule.replacements?.entries ?? {};
  const replacements = new Map<string, string>(Object.entries(entries));
  if (replacements.size > MAX_SHORTCUTS) throw new InlineRegistrationError(`at most ${MAX_SHORTCUTS} inline shortcuts`);
  for (const [key, value] of replacements) {
    if (
      typeof key !== 'string' ||
      typeof value !== 'string' ||
      !shortcutKey.test(key) ||
      [...key].length > MAX_TRIGGER_POINTS ||
      unsafeText(key) !== null ||
      unsafeText(value) !== null ||
      utf8Length(value) > maxInsertBytes
    ) {
      throw new InlineRegistrationError(`invalid inline shortcut ${JSON.stringify(key)}`);
    }
  }
  return replacements;
}

function tableOf(rule: InlineRules, ctx: RegisterContext): PackedTable | undefined {
  if (!rule.table) return undefined;
  if (rule.table.format !== TABLE_FORMAT) throw new InlineRegistrationError('invalid inline table format');
  const supplied = ctx.assets?.[rule.table.asset];
  if (!supplied) throw new InlineRegistrationError(`inline asset ${JSON.stringify(rule.table.asset)} is missing`);
  const bytes = supplied instanceof Uint8Array ? supplied : new Uint8Array(supplied);
  if (bytes.byteLength < 40 || bytes.byteLength > MAX_TABLE_BYTES) {
    throw new InlineRegistrationError('invalid inline table size');
  }
  if (!Number.isInteger(rule.table.entries) || rule.table.entries < 1 || rule.table.entries > MAX_TABLE_ENTRIES) {
    throw new InlineRegistrationError('invalid inline table entry count');
  }
  const receipt = ctx.receipts?.[rule.table.asset] ?? {
    sha256: rule.table.sha256,
    entries: rule.table.entries,
    bytes: bytes.byteLength,
    formatVersion: 1 as const,
  };
  return openTable(bytes, receipt, ctx.sha256);
}

/**
 * Validates one rule set and returns the immutable lookup data, or throws
 * `InlineRegistrationError`. Third-party specs, a wrong owner, missing write
 * permission, or a function in the data are all refusals.
 */
export function registerRuleSet(raw: InlineRules, ctx: RegisterContext): RegisteredInline {
  if (!ctx.builtin) throw new InlineRegistrationError('third-party inline tables are refused');
  if (!ctx.permissions.includes('draft:read') && !ctx.permissions.includes('draft:read:full')) {
    throw new InlineRegistrationError('inline rules need draft:read');
  }
  if (!ctx.permissions.includes('draft:write')) throw new InlineRegistrationError('inline rules need draft:write');
  const rule = cloneData(raw);
  if (rule.owner !== ctx.owner || !rule.id || !Number.isFinite(rule.priority) || typeof rule.enabled !== 'boolean') {
    throw new InlineRegistrationError('invalid inline owner, id or priority');
  }
  if (rule.policy !== ENGLISH_POLICY) throw new InlineRegistrationError(`unknown inline policy ${rule.policy}`);
  const policy = policyByName(rule.policy);
  if (!policy) throw new InlineRegistrationError(`unknown inline policy ${rule.policy}`);
  checkFlags(rule);
  if (!Number.isInteger(rule.maxInsertBytes) || rule.maxInsertBytes < 1 || rule.maxInsertBytes > MAX_INSERT_BYTES) {
    throw new InlineRegistrationError('invalid maxInsertBytes');
  }
  const inlineLimit = rule.inlineMaxInsertBytes;
  if (!Number.isInteger(inlineLimit) || inlineLimit < 1 || inlineLimit > rule.maxInsertBytes) {
    throw new InlineRegistrationError('invalid inlineMaxInsertBytes');
  }
  const table = tableOf(rule, ctx);
  if (table && table.entries !== rule.table?.entries) {
    throw new InlineRegistrationError('inline table entry count does not match the descriptor');
  }
  const replacements = replacementsOf(rule, rule.maxInsertBytes);
  const fieldCursors = new Map<string, number>();
  for (const [name, offset] of Object.entries(rule.replacements?.cursors ?? {})) {
    if (replacements.has(name) && Number.isInteger(offset) && offset >= 0) fieldCursors.set(name, offset);
  }
  const vocabulary = new Set((rule.vocabulary ?? []).map((word) => word.toLowerCase()));
  const transport = ctx.transportMaxBytes > 0 ? ctx.transportMaxBytes : inlineLimit;
  return {
    id: rule.id,
    owner: rule.owner,
    priority: rule.priority,
    enabled: rule.enabled,
    policy,
    table,
    replacements,
    fieldCursors,
    vocabulary,
    inlineMaxBytes: Math.min(inlineLimit, transport),
    maxInsertBytes: rule.maxInsertBytes,
  };
}

export function lookupWord(table: PackedTable | undefined, word: string): string | null {
  if (!table) return null;
  return lookup(table, word) ?? null;
}

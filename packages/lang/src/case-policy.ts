// The case policy file (`murmo-case-policy/v1`). Packed bytes can't say that a
// key corrects only when typed in lowercase (r8: SCOWL lists `Teh` and `Thier`
// as names and `ADN` as an abbreviation), so the pack ships that list next to
// the table and the manifest binds the two by hash. Applying it is the word
// policy's job (docs/plan/13); this module only reads and checks the data.

import { CASE_POLICY_FORMAT } from './manifest.ts';
import { findEntry, type PackedTable } from './table.ts';

export interface CasePolicy {
  /** Keys that correct only when the typed word is exactly this lowercase key. */
  readonly lowercaseOnly: ReadonlySet<string>;
}

export class CasePolicyError extends Error {
  constructor(message: string) {
    super(`case policy: ${message}`);
    this.name = 'CasePolicyError';
  }
}

/**
 * Checks the parsed file: the format, sorted unique lowercase ASCII keys, and,
 * given the table, that every key is in it (a policy for a missing key means
 * the files don't belong together).
 */
export function parseCasePolicy(json: unknown, table?: PackedTable): CasePolicy {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new CasePolicyError('must be an object');
  const o = json as Record<string, unknown>;
  if (o.format !== CASE_POLICY_FORMAT) throw new CasePolicyError(`format must be ${CASE_POLICY_FORMAT}`);
  for (const key of Object.keys(o)) {
    if (!['format', 'lowercaseOnly', 'reason'].includes(key)) throw new CasePolicyError(`unknown field "${key}"`);
  }
  if (typeof o.reason !== 'string' || o.reason.length === 0) throw new CasePolicyError('reason must say why');
  const keys = o.lowercaseOnly;
  if (!Array.isArray(keys)) throw new CasePolicyError('lowercaseOnly must be an array');
  let previous = '';
  for (const key of keys) {
    if (typeof key !== 'string' || !/^[a-z]{1,64}$/.test(key)) {
      throw new CasePolicyError(`key ${JSON.stringify(key)} is not lowercase ASCII`);
    }
    if (key <= previous) throw new CasePolicyError(`keys must be sorted and unique ("${key}")`);
    if (table && findEntry(table, key) < 0) throw new CasePolicyError(`key "${key}" is not in the table`);
    previous = key;
  }
  return { lowercaseOnly: new Set(keys as string[]) };
}
